#!/usr/bin/env node
/**
 * tests/smoke.mjs —— 面板端到端冒烟测试（**不依赖上游、不消耗额度、不需要凭据**）
 *
 * 起一个临时实例（独立端口 + 临时数据库），验证 HTTP 层全部可用，然后关掉。
 * 显式关闭节点池与模型发现，保证 CI 里是纯粹的本机自检。
 *
 *   node tests/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = path.join(ROOT, '01-管理面板');
const PORT = Number(process.env.SMOKE_PORT || 18790);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ocgw-smoke-'));
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [OK]   ${m}`); };
const bad = (m) => { fail++; console.log(`  [FAIL] ${m}`); };
const check = async (name, fn) => {
  try { const r = await fn(); ok(`${name}  ->  ${r ?? ''}`); }
  catch (e) { bad(`${name}  ->  ${String(e.message).slice(0, 160)}`); }
};

console.log(`\n面板冒烟测试  端口 ${PORT}  DB ${WORK}`);

const child = spawn(process.execPath, [path.join(PANEL, 'server.mjs')], {
  cwd: PANEL,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PANEL_PORT: String(PORT),
    PANEL_HOST: '127.0.0.1',
    PANEL_DB: path.join(WORK, 'panel.db'),
    PANEL_PASSWORD: 'smoke-pass',
    PANEL_NODE_POOL: '0',            // CI 里不起代理池
    PANEL_MODEL_DISCOVERY: '0',      // CI 里不连上游
    MIHOMO_RUNTIME: path.join(WORK, 'mihomo'),  // 订阅/内核数据也放临时目录，别写进仓库
  },
});

let logs = '';
child.stdout.on('data', (c) => { logs += c; });
child.stderr.on('data', (c) => { logs += c; });

const cleanup = () => { try { child.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

/* 等服务起来 */
let up = false;
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (child.exitCode !== null) break;
  try { const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(1500) }); if (r.status === 200) { up = true; break; } } catch { /* 还没起 */ }
}
if (!up) {
  console.log('  [FAIL] 服务未在 20s 内监听');
  console.log(logs.split('\n').slice(-20).map((l) => '         ' + l).join('\n'));
  
const J = (p, o = {}) => fetch(BASE + p, { ...o, headers: { cookie, 'content-type': 'application/json', ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

await check('代理订阅：全新安装为空', async () => {
  const r = await J('/api/proxy-pool/providers');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  if (r.json.rows.length !== 0) throw new Error('竟然预置了 ' + r.json.rows.length + ' 个订阅');
  return '0 个';
});

await check('代理订阅：添加 + URL 打码 + 删除', async () => {
  const c = await J('/api/proxy-pool/providers', { method: 'POST', body: { name: 'smoke-p', url: 'https://example.com/sub?token=SECRET' } });
  if (!c.json.provider) throw new Error('添加失败: ' + JSON.stringify(c.json).slice(0, 100));
  if (String(c.json.provider.urlMasked).includes('SECRET')) throw new Error('URL 未打码，泄漏 token');
  const l = await J('/api/proxy-pool/providers');
  if (!l.json.rows.some((x) => x.name === 'smoke-p')) throw new Error('列表里没有');
  const d = await J('/api/proxy-pool/providers?name=smoke-p', { method: 'DELETE' });
  if (!d.json.ok) throw new Error('删除失败');
  const l2 = await J('/api/proxy-pool/providers');
  if (l2.json.rows.length !== 0) throw new Error('删除后仍有残留');
  return '增/查/删 全通';
});

await check('代理订阅：拒绝非法名与非 http 链接', async () => {
  const a = await J('/api/proxy-pool/providers', { method: 'POST', body: { name: '中文名', url: 'https://a.com/x' } });
  if (a.status < 400) throw new Error('非法名竟然通过了');
  const b = await J('/api/proxy-pool/providers', { method: 'POST', body: { name: 'ok', url: 'ftp://a.com/x' } });
  if (b.status < 400) throw new Error('非 http 链接竟然通过了');
  return '校验生效';
});

await check('手动节点：添加 → 列表可见 → 剔除 → 恢复 → 删除', async () => {
  const c = await J('/api/proxy-pool/nodes/manual', { method: 'POST', body: { name: 'smoke-node', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-128-gcm', password: 'pw' } });
  if (!c.json.ok) throw new Error('添加失败: ' + JSON.stringify(c.json).slice(0, 100));
  const l = await J('/api/proxy-pool/nodes?all=1');
  const n = l.json.rows.find((x) => x.name === 'smoke-node');
  if (!n) throw new Error('手加节点未出现在列表');
  if (!n.valid) throw new Error('手加节点被判无效: ' + n.invalidReason);
  if (!n.manual) throw new Error('manual 标记缺失');
  await J('/api/proxy-pool/nodes/exclude?name=smoke-node&on=1', { method: 'POST' });
  const l2 = await J('/api/proxy-pool/nodes?all=1');
  if (l2.json.rows.find((x) => x.name === 'smoke-node').valid) throw new Error('剔除没生效');
  await J('/api/proxy-pool/nodes/exclude?name=smoke-node&on=0', { method: 'POST' });
  const l2b = await J('/api/proxy-pool/nodes?all=1');
  if (!l2b.json.rows.find((x) => x.name === 'smoke-node').valid) throw new Error('恢复没生效');
  await J('/api/proxy-pool/nodes/manual?name=smoke-node', { method: 'DELETE' });
  const l3 = await J('/api/proxy-pool/nodes?all=1');
  if (l3.json.rows.some((x) => x.name === 'smoke-node')) throw new Error('删除后仍在');
  return '增/查/剔除/恢复/删 全通';
});

await check('应用配置：渲染 config.yaml', async () => {
  const r = await J('/api/proxy-pool/apply', { method: 'POST' });
  if (!r.json.ok) throw new Error('apply 失败: ' + JSON.stringify(r.json).slice(0, 120));
  return '订阅 ' + (r.json.providers || []).length + ' 个';
});
await check('内核状态接口（不触发下载）', async () => {
  const r = await J('/api/proxy-pool/core');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  if (typeof r.json.installed !== 'boolean') throw new Error('缺 installed 字段');
  if (r.json.installed) throw new Error('临时运行时目录里不该有内核');
  if (!/^(windows|linux|darwin)-(amd64|arm64|armv7)$/.test(r.json.platform)) throw new Error('platform 异常: ' + r.json.platform);
  if (!r.json.job) throw new Error('缺 job 字段（界面要靠它轮询进度）');
  return 'platform=' + r.json.platform + ' installed=false';
});

await check('内核安装：缺 runtime 不会崩（接口健在）', async () => {
  const r = await J('/api/proxy-pool/core/use', { method: 'POST', body: { path: '' } });
  if (r.status < 400) throw new Error('空路径竟然通过了');
  return '已拒绝空路径';
});


cleanup();
  process.exit(1);
}
ok(`服务已监听 ${BASE}`);

let cookie = '';
let TOKEN = '';

await check('GET / 管理面板 HTML', async () => {
  const r = await fetch(BASE + '/');
  const t = await r.text();
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  if (t.length < 5000) throw new Error(`HTML 太小 ${t.length}`);
  return `HTTP 200, ${t.length} 字节`;
});

await check('POST /api/login', async () => {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.PANEL_PASSWORD || 'smoke-pass' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const j = await r.json();
  if (!j.ok || !cookie) throw new Error(`ok=${j.ok} cookie=${!!cookie}`);
  return '{"ok":true} + cookie';
});

await check('GET /api/channels (全新安装应为空，不内置任何渠道)', async () => {
  const j = await (await fetch(BASE + '/api/channels', { headers: { cookie } })).json();
  if (j.rows.length !== 0) throw new Error('竟然内置了 ' + j.rows.length + ' 个渠道: ' + j.rows.map((r) => r.name).join(','));
  return '0 个渠道（由用户自己添加）';
});

await check('POST /api/channels (用户自己填渠道 + 模型)', async () => {
  const r = await fetch(BASE + '/api/channels', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'smoke-channel',
      type: 'openai',
      base_url: 'https://example.com/v1/chat/completions',
      api_key: 'public',
      models: ['smoke-model-a', 'smoke-model-b'],
      priority: 50,
      status: 1,
    }),
  });
  const j = await r.json();
  if (!j.id) throw new Error('创建失败: ' + JSON.stringify(j).slice(0, 120));
  if (j.models.length !== 2) throw new Error('模型数不对: ' + j.models.length);
  return 'id=' + j.id + ' 模型 ' + j.models.join(',');
});

await check('POST /api/tokens 建令牌', async () => {
  const r = await fetch(BASE + '/api/tokens', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke', unlimited: true }),
  });
  const j = await r.json();
  if (!j.key || !j.key.startsWith('sk-')) throw new Error('未返回 key');
  TOKEN = j.key;
  return `${j.key.slice(0, 10)}…`;
});

await check('GET /v1/models (OpenAI 兼容)', async () => {
  const r = await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer ' + TOKEN } });
  const j = await r.json();
  if (!Array.isArray(j.data)) throw new Error('data 不是数组');
  if (j.data.length < 1) throw new Error('模型列表为空');
  // 不再内置模型：列表必须正好等于用户在那个渠道里填的 2 个
  if (j.data.length !== 2) throw new Error(`模型数不对，期望 2 个（用户填的），实际 ${j.data.length}`);
  const ids = j.data.map((m) => m.id).sort();
  if (ids.join(',') !== 'smoke-model-a,smoke-model-b') throw new Error('模型 id 不对: ' + ids.join(','));
  return `${j.data.length} 个模型`;
});

await check('GET /v1/models 缺令牌应 401', async () => {
  const r = await fetch(BASE + '/v1/models');
  if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`);
  return 'HTTP 401';
});

await check('GET /api/protocols', async () => {
  const j = await (await fetch(BASE + '/api/protocols', { headers: { cookie } })).json();
  if (!Array.isArray(j.rows)) throw new Error('无 rows');
  return `${j.rows.length} 行`;
});

await check('GET /api/models/catalog', async () => {
  const j = await (await fetch(BASE + '/api/models/catalog', { headers: { cookie } })).json();
  if (typeof j.upstreamTotal !== 'number') throw new Error('字段缺失');
  return `上游 ${j.upstreamTotal} · free ${j.freeCandidates} · 可用 ${j.usable}`;
});

await check('GET /api/proxy-pool (节点池关闭时不报错)', async () => {
  const r = await fetch(BASE + '/api/proxy-pool', { headers: { cookie } });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return `enabled=${j.enabled}`;
});

await check('POST /v1/chat/completions 非法请求应 400', async () => {
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x' }),   // 缺 messages
  });
  if (r.status !== 400) throw new Error(`期望 400，实际 ${r.status}`);
  return 'HTTP 400';
});

await check('POST /api/login 错误密码应被拒', async () => {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  const j = await r.json();
  if (j.ok) throw new Error('错误密码竟然登录成功');
  return '已拒绝';
});

await check('未知路径应 404', async () => {
  const r = await fetch(BASE + '/definitely-not-here');
  if (r.status !== 404) throw new Error(`期望 404，实际 ${r.status}`);
  return 'HTTP 404';
});


const J = (p, o = {}) => fetch(BASE + p, { ...o, headers: { cookie, 'content-type': 'application/json', ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

await check('代理订阅：全新安装为空', async () => {
  const r = await J('/api/proxy-pool/providers');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  if (r.json.rows.length !== 0) throw new Error('竟然预置了 ' + r.json.rows.length + ' 个订阅');
  return '0 个';
});

await check('代理订阅：添加 + URL 打码 + 删除', async () => {
  const c = await J('/api/proxy-pool/providers', { method: 'POST', body: { name: 'smoke-p', url: 'https://example.com/sub?token=SECRET' } });
  if (!c.json.provider) throw new Error('添加失败: ' + JSON.stringify(c.json).slice(0, 100));
  if (String(c.json.provider.urlMasked).includes('SECRET')) throw new Error('URL 未打码，泄漏 token');
  const l = await J('/api/proxy-pool/providers');
  if (!l.json.rows.some((x) => x.name === 'smoke-p')) throw new Error('列表里没有');
  const d = await J('/api/proxy-pool/providers?name=smoke-p', { method: 'DELETE' });
  if (!d.json.ok) throw new Error('删除失败');
  const l2 = await J('/api/proxy-pool/providers');
  if (l2.json.rows.length !== 0) throw new Error('删除后仍有残留');
  return '增/查/删 全通';
});

await check('代理订阅：拒绝非法名与非 http 链接', async () => {
  const a = await J('/api/proxy-pool/providers', { method: 'POST', body: { name: '中文名', url: 'https://a.com/x' } });
  if (a.status < 400) throw new Error('非法名竟然通过了');
  const b = await J('/api/proxy-pool/providers', { method: 'POST', body: { name: 'ok', url: 'ftp://a.com/x' } });
  if (b.status < 400) throw new Error('非 http 链接竟然通过了');
  return '校验生效';
});

await check('手动节点：添加 → 列表可见 → 剔除 → 恢复 → 删除', async () => {
  const c = await J('/api/proxy-pool/nodes/manual', { method: 'POST', body: { name: 'smoke-node', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-128-gcm', password: 'pw' } });
  if (!c.json.ok) throw new Error('添加失败: ' + JSON.stringify(c.json).slice(0, 100));
  const l = await J('/api/proxy-pool/nodes?all=1');
  const n = l.json.rows.find((x) => x.name === 'smoke-node');
  if (!n) throw new Error('手加节点未出现在列表');
  if (!n.valid) throw new Error('手加节点被判无效: ' + n.invalidReason);
  if (!n.manual) throw new Error('manual 标记缺失');
  await J('/api/proxy-pool/nodes/exclude?name=smoke-node&on=1', { method: 'POST' });
  const l2 = await J('/api/proxy-pool/nodes?all=1');
  if (l2.json.rows.find((x) => x.name === 'smoke-node').valid) throw new Error('剔除没生效');
  await J('/api/proxy-pool/nodes/exclude?name=smoke-node&on=0', { method: 'POST' });
  const l2b = await J('/api/proxy-pool/nodes?all=1');
  if (!l2b.json.rows.find((x) => x.name === 'smoke-node').valid) throw new Error('恢复没生效');
  await J('/api/proxy-pool/nodes/manual?name=smoke-node', { method: 'DELETE' });
  const l3 = await J('/api/proxy-pool/nodes?all=1');
  if (l3.json.rows.some((x) => x.name === 'smoke-node')) throw new Error('删除后仍在');
  return '增/查/剔除/恢复/删 全通';
});

await check('应用配置：渲染 config.yaml', async () => {
  const r = await J('/api/proxy-pool/apply', { method: 'POST' });
  if (!r.json.ok) throw new Error('apply 失败: ' + JSON.stringify(r.json).slice(0, 120));
  return '订阅 ' + (r.json.providers || []).length + ' 个';
});
await check('内核状态接口（不触发下载）', async () => {
  const r = await J('/api/proxy-pool/core');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  if (typeof r.json.installed !== 'boolean') throw new Error('缺 installed 字段');
  if (r.json.installed) throw new Error('临时运行时目录里不该有内核');
  if (!/^(windows|linux|darwin)-(amd64|arm64|armv7)$/.test(r.json.platform)) throw new Error('platform 异常: ' + r.json.platform);
  if (!r.json.job) throw new Error('缺 job 字段（界面要靠它轮询进度）');
  return 'platform=' + r.json.platform + ' installed=false';
});

await check('内核安装：缺 runtime 不会崩（接口健在）', async () => {
  const r = await J('/api/proxy-pool/core/use', { method: 'POST', body: { path: '' } });
  if (r.status < 400) throw new Error('空路径竟然通过了');
  return '已拒绝空路径';
});
await check('配置导出：默认不含令牌与密码', async () => {
  const r = await J('/api/config/export');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  if (r.json.kind !== 'opencode-free-gateway/config') throw new Error('kind 不对: ' + r.json.kind);
  if (r.json.tokens) throw new Error('默认不应导出令牌');
  if (JSON.stringify(r.json).includes('admin_password')) throw new Error('不应含密码哈希');
  return 'channels=' + (r.json.channels || []).length;
});

await check('配置导出：download=1 带 attachment 头', async () => {
  const r = await fetch(BASE + '/api/config/export?download=1&tokens=0', { headers: { cookie } });
  const cd = r.headers.get('content-disposition') || '';
  if (!cd.includes('attachment')) throw new Error('缺 content-disposition: ' + cd);
  return cd.slice(0, 50);
});

await check('配置导入：拒绝非本项目格式', async () => {
  const r = await J('/api/config/import', { method: 'POST', body: { bundle: { kind: 'nope' } } });
  if (r.status < 400) throw new Error('竟然通过了');
  return 'HTTP ' + r.status;
});

await check('Clash 导入：预览不写库', async () => {
  const yaml = 'proxy-providers:\n  p1:\n    type: http\n    url: "https://a.example/sub"\nproxies:\n  - { name: n1, type: ss, server: 1.1.1.1, port: 8388 }\n';
  const before = (await J('/api/proxy-pool/providers')).json.rows.length;
  const r = await J('/api/config/import-clash', { method: 'POST', body: { yaml, dryRun: true } });
  if (!r.json.ok) throw new Error('解析失败');
  const after = (await J('/api/proxy-pool/providers')).json.rows.length;
  if (after !== before) throw new Error('预览竟然写入了库');
  return 'providers=' + r.json.providers + ' proxies=' + r.json.proxies;
});

await check('Clash 导入：真写入并渲染配置', async () => {
  const yaml = 'proxies:\n  - { name: smoke-clash-node, type: ss, server: 3.3.3.3, port: 443, cipher: aes-128-gcm, password: x }\n';
  const r = await J('/api/config/import-clash', { method: 'POST', body: { yaml, mode: 'merge' } });
  if (!r.json.ok) throw new Error('导入失败: ' + JSON.stringify(r.json).slice(0, 120));
  const nodes = await J('/api/proxy-pool/nodes?all=1');
  if (!nodes.json.rows.some((x) => x.name === 'smoke-clash-node')) throw new Error('节点没进库');
  return 'added=' + r.json.addedProxies;
});

await check('填完整 chat 地址的渠道也能正确路由（曾有重复后缀 bug）', async () => {
  // 起一个本地回显上游，只验网关拼出的路径对不对
  const http2 = await import('node:http');
  const echo = http2.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'e', object: 'chat.completion', created: 1, model: 'echo',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ECHO' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((r) => echo.listen(18797, '127.0.0.1', r));
  try {
    const ch = await fetch(BASE + '/api/channels', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'urlfix', type: 'openai', base_url: 'http://127.0.0.1:18797/v1/chat/completions', api_key: 'x', models: ['echo-m'], priority: 1, status: 1 }) });
    const { id } = await ch.json();
    const tk = await fetch(BASE + '/api/tokens', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'u', unlimited: true }) });
    const { key } = await tk.json();
    const r = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'echo-m', messages: [{ role: 'user', content: 'hi' }] }) });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200) throw new Error('HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
    if (j.choices?.[0]?.message?.content !== 'ECHO') throw new Error('内容不对: ' + JSON.stringify(j).slice(0, 200));
    await fetch(BASE + '/api/channels/' + id, { method: 'DELETE', headers: { cookie } });
    return '路径正确 + 响应回传正常';
  } finally {
    await new Promise((r) => echo.close(r));
  }
});

cleanup();
await new Promise((r) => setTimeout(r, 400));

console.log(`\n冒烟测试: ${pass} 通过, ${fail} 失败`);
if (fail) { console.log('\n--- 面板日志尾部 ---'); console.log(logs.split('\n').slice(-25).map((l) => '  ' + l).join('\n')); }
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
