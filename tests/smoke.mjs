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

await check('GET /api/channels (默认种子渠道)', async () => {
  const j = await (await fetch(BASE + '/api/channels', { headers: { cookie } })).json();
  if (!j.rows) throw new Error('无 rows');
  return `${j.rows.length} 个渠道`;
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
  // 默认渠道种子有 11 个模型；少于 10 个说明「动态发现结果替换了手配清单」的
  // 截断问题回归了（探测异步跑，跑到一半时列表会变短）
  if (j.data.length < 10) throw new Error(`模型被截断，只有 ${j.data.length} 个（预期 >= 10）`);
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

cleanup();
await new Promise((r) => setTimeout(r, 400));

console.log(`\n冒烟测试: ${pass} 通过, ${fail} 失败`);
if (fail) { console.log('\n--- 面板日志尾部 ---'); console.log(logs.split('\n').slice(-25).map((l) => '  ' + l).join('\n')); }
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
