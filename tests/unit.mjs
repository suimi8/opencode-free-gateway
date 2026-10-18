#!/usr/bin/env node
/**
 * tests/unit.mjs —— 纯逻辑单元测试（无网络、无凭据、无副作用）
 *
 * 覆盖协议互转层 bridge.mjs：跨协议互转是「两种协议都能用全部模型」的核心，
 * 它一旦回归，Codex / OpenAI SDK 会拿到看不懂的响应，而且不报错只出错数据。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows 下动态 import 必须用 file:// URL，直接给绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const B = await import(pathToFileURL(path.join(ROOT, '01-管理面板', 'bridge.mjs')).href);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  [OK]   ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`); }
};
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
};
const feed = (conv, sse) => { let out = ''; for (const l of sse.split('\n')) out += conv.push(l); return out; };

console.log('\n── 1) chat → responses 请求体 ──');
const r1 = B.chatToResponses({
  model: 'm',
  messages: [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'R' },
  ],
  tools: [{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object', properties: {} } } }],
  stream: false,
});
eq('system → instructions', r1.instructions, 'S');
eq('stream 强制 true', r1.stream, true);
eq('input 条数', r1.input.length, 3);
eq('user 项形状', r1.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'U' }] });
eq('function_call 项', r1.input[1].type, 'function_call');
eq('function_call_output 项', r1.input[2].type, 'function_call_output');
eq('tools 扁平化', r1.tools[0].name, 'read');
ok('不带 max_tokens（Responses 会拒）', !('max_tokens' in r1));

console.log('\n── 2) responses → chat 请求体 ──');
const r2 = B.responsesToChat({
  model: 'm',
  instructions: 'S',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'U' }] },
    { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  ],
  tools: [{ type: 'function', name: 'shell', description: 'd', parameters: { type: 'object', properties: {} } }],
  stream: true,
});
eq('messages 条数 (system+user+assistant+tool)', r2.messages.length, 4);
eq('第 1 条 system', r2.messages[0], { role: 'system', content: 'S' });
eq('assistant 带 tool_calls', r2.messages[2].tool_calls[0].id, 'c1');
eq('tool 角色', r2.messages[3].role, 'tool');
eq('tools 嵌套化', r2.tools[0].function.name, 'shell');

console.log('\n── 3) 往返不丢信息 ──');
const back = B.responsesToChat(B.chatToResponses({ model: 'm', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], stream: true }));
eq('chat→responses→chat', back.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);

console.log('\n── 4) chat SSE → responses SSE ──');
const s = B.makeChatToResponsesStream('m');
let acc = feed(s, `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n`);
acc += feed(s, `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hel' } }] })}\n`);
acc += feed(s, `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'lo' } }] })}\n`);
acc += feed(s, `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } })}\n`);
const fin = s.end();
acc += fin.sse;
const evs = [...acc.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
for (const need of ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']) {
  ok(`事件序列含 ${need}`, evs.includes(need), `实际: ${evs.join('→')}`);
}
eq('累计文本', fin.text, 'Hello');
eq('completed.usage.input_tokens', fin.response.usage.input_tokens, 11);

console.log('\n── 5) 工具调用 chat SSE → responses SSE ──');
const s3 = B.makeChatToResponsesStream('m');
let a3 = feed(s3, `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c9', type: 'function', function: { name: 'read', arguments: '{"p"' } }] } }] })}\n`);
a3 += feed(s3, `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] } }] })}\n`);
a3 += feed(s3, `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n`);
a3 += s3.end().sse;
ok('产生 function_call 项', a3.includes('function_call'));
ok('参数分片拼接完整', a3.includes('a.txt') || a3.includes(':"a"}') || a3.includes('{\\"p\\":\\"a\\"}'));

console.log('\n── 6) responses SSE → chat SSE ──');
const c2 = B.makeResponsesToChatStream('m');
let out2 = feed(c2, `data: ${JSON.stringify({ type: 'response.created', response: { id: 'r', status: 'in_progress' } })}\n`);
out2 += feed(c2, `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hel' })}\n`);
out2 += feed(c2, `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'lo' })}\n`);
out2 += feed(c2, `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }], usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 } } })}\n`);
out2 += c2.end();
const chunks = out2.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
ok('以 [DONE] 结束', chunks[chunks.length - 1] === '[DONE]');
const agg = B.aggregateChatSSE(out2, 'm', 'm');
eq('聚合文本', agg.choices[0].message.content, 'Hello');
eq('聚合 usage', agg.usage.total_tokens, 11);
eq('finish_reason', agg.choices[0].finish_reason, 'stop');

console.log('\n── 7) responses 工具调用 → chat ──');
const c3 = B.makeResponsesToChatStream('m');
let out3 = feed(c3, `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'c7', name: 'read', arguments: '{"p":"a"}' }], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } })}\n`);
out3 += c3.end();
const agg3 = B.aggregateChatSSE(out3, 'm', 'm');
ok('聚合出 tool_calls', Array.isArray(agg3.choices[0].message.tool_calls) && agg3.choices[0].message.tool_calls.length === 1);
eq('tool 名字', agg3.choices[0].message.tool_calls?.[0]?.function?.name, 'read');
eq('finish_reason=tool_calls', agg3.choices[0].finish_reason, 'tool_calls');

console.log('\n── 8) 非流式聚合 ──');
const rs = B.aggregateResponsesSSE(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed' } })}\n`);
eq('聚合出最终 response', rs?.status, 'completed');

/* ══════════════════════════════════════════════ 9) 代理订阅存储
 * 用临时 runtime 目录，绝不碰真实的订阅/内核数据。
 */
console.log('\n── 9) 代理订阅存储 ──');
const os = await import('node:os');
const fsx = await import('node:fs');
const TMPRT = fsx.mkdtempSync(path.join(os.tmpdir(), 'ocgw-substest-'));
process.env.MIHOMO_RUNTIME = TMPRT;
process.env.PANEL_NODE_POOL = '0';
const M = await import(pathToFileURL(path.join(ROOT, '10-代理节点管理', 'mihomo.mjs')).href);

eq('maskUrl 打码 token', M.maskUrl('https://a.com/sub?token=SECRET123&x=1').includes('SECRET123'), false);
eq('maskUrl 保留主机与路径', M.maskUrl('https://a.com/sub?token=SECRET123').startsWith('https://a.com/sub'), true);
eq('maskUrl 非 URL 也能打码', M.maskUrl('not-a-url?token=ABC').includes('ABC'), false);

eq('全新安装 providers 为空', M.listProviders().length, 0);
let threw = false;
try { M.upsertProvider({ name: '中文名', url: 'https://a.com/x' }); } catch { threw = true; }
eq('拒绝非法订阅名', threw, true);
threw = false;
try { M.upsertProvider({ name: 'ok', url: 'ftp://a.com/x' }); } catch { threw = true; }
eq('拒绝非 http 链接', threw, true);

M.upsertProvider({ name: 'p1', url: 'https://a.com/sub?token=ZZZ999' });
eq('添加订阅成功', M.listProviders().length, 1);
eq('列表里 URL 已打码', M.listProviders()[0].urlMasked.includes('ZZZ999'), false);
M.upsertProvider({ name: 'p1', enabled: false });
eq('编辑时省略 url 保留原链接', M.listProviders()[0].url.includes('ZZZ999'), true);
eq('编辑可改 enabled', M.listProviders()[0].enabled, false);
M.setProviderEnabled('p1', true);
eq('切换启用', M.listProviders()[0].enabled, true);

threw = false;
try { M.addManualProxy({ name: 'n1', type: 'ss', port: 1 }); } catch { threw = true; }
eq('手加节点缺 server 应拒绝', threw, true);
threw = false;
try { M.addManualProxy({ name: 'n1', type: 'ss', server: '1.2.3.4', port: 0 }); } catch { threw = true; }
eq('手加节点 port 非法应拒绝', threw, true);
M.addManualProxy({ name: 'n1', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-128-gcm', password: 'pw' });
eq('手加节点成功', M.loadSubs().manualProxies.length, 1);
threw = false;
try { M.addManualProxy({ name: 'n1', type: 'ss', server: '5.6.7.8', port: 1 }); } catch { threw = true; }
eq('拒绝重名手加节点', threw, true);

eq('providerNodes 含手加节点', M.providerNodes().some((n) => n.name === 'n1' && n.manual), true);
eq('手加节点默认有效', M.providerNodes().find((n) => n.name === 'n1').valid, true);
M.setNodeExcluded('n1', true);
eq('剔除后 invalid', M.providerNodes().find((n) => n.name === 'n1').valid, false);
eq('剔除原因正确', M.providerNodes().find((n) => n.name === 'n1').reason, '已被面板剔除');
M.setNodeExcluded('n1', false);
eq('恢复后 valid', M.providerNodes().find((n) => n.name === 'n1').valid, true);

const rendered = M.renderConfig();
const cfg = fsx.readFileSync(rendered.configPath, 'utf8');
eq('config 出现手加节点 proxies 段', /^proxies:/m.test(cfg), true);
eq('组里包含手加节点', cfg.includes("'n1'"), true);
eq('applyConfig 已导出', typeof M.applyConfig, 'function');

M.removeManualProxy('n1');
eq('删除手加节点', M.loadSubs().manualProxies.length, 0);
M.deleteProvider('p1');
eq('删除订阅', M.listProviders().length, 0);
try { fsx.rmSync(TMPRT, { recursive: true, force: true }); } catch { /* 忽略 */ }

/* ══════════════════════════════════════════════ 10) 内核安装（core-install.mjs） */
console.log('\n── 10) 内核安装 ──');
const CORE = await import(pathToFileURL(path.join(ROOT, '10-代理节点管理', 'core-install.mjs')).href);
eq('platformTag 形状正确', /^(windows|linux|darwin)-(amd64|arm64|armv7)$/.test(CORE.platformTag()), true);
eq('platformTag 可按参数覆盖', CORE.platformTag('linux', 'arm64'), 'linux-arm64');
eq('platformTag 拒绝未知平台', (() => { try { CORE.platformTag('aix', 'x64'); return false; } catch { return true; } })(), true);
eq('platformTag 拒绝未知架构', (() => { try { CORE.platformTag('linux', 'mips'); return false; } catch { return true; } })(), true);

const EMPTYRT = fsx.mkdtempSync(path.join(os.tmpdir(), 'ocgw-coretest-'));
const cst = CORE.coreStatus(EMPTYRT);
eq('空目录：未安装', cst.installed, false);
eq('空目录：exists=false', cst.exists, false);
eq('空目录：size=0', cst.sizeBytes, 0);
eq('coreStatus 带平台标记', /^(windows|linux|darwin)-/.test(cst.platform), true);
eq('haveCore 空目录返回 null', CORE.haveCore(EMPTYRT), null);
eq('JOB 初始不运行', CORE.JOB.running, false);
eq('installCore 缺 runtime 应报错', (await CORE.installCore({})).ok, false);
eq('installCore 报错时 JOB 记下原因', typeof CORE.JOB.error === 'string' && CORE.JOB.error.length > 0, true);
try { fsx.rmSync(EMPTYRT, { recursive: true, force: true }); } catch { /* 忽略 */ }


/* ══════════════════════════════════════════════ 11) 配置导出/导入 + Clash 解析 */
console.log('\n── 11) 配置迁移 ──');
process.env.PANEL_DB = path.join(fsx.mkdtempSync(path.join(os.tmpdir(), 'ocgw-cfgtest-')), 'panel.db');
const CFG = await import(pathToFileURL(path.join(ROOT, '01-管理面板', 'config-io.mjs')).href);
const DBm = await import(pathToFileURL(path.join(ROOT, '01-管理面板', 'db.mjs')).href);
DBm.ensureDefaults();

eq('bundle kind 正确', CFG.buildBundle().kind, 'opencode-free-gateway/config');
eq('空库导出渠道为空', CFG.buildBundle().channels.length, 0);
eq('默认不导出令牌', CFG.buildBundle().tokens, undefined);
eq('导出内容不含密码哈希', JSON.stringify(CFG.buildBundle()).includes('admin_password'), false);

eq('拒绝非本项目 bundle', (() => { try { CFG.applyBundle({ kind: 'x' }); return false; } catch { return true; } })(), true);
eq('拒绝更高版本', (() => { try { CFG.applyBundle({ kind: CFG.BUNDLE_KIND, version: 999 }); return false; } catch { return true; } })(), true);

const rt = CFG.applyBundle({
  kind: CFG.BUNDLE_KIND, version: 1,
  site: { site_name: '导入的站点' },
  channels: [{ name: 'c1', type: 'openai', base_url: 'https://x/v1/chat/completions', api_key: 'k', models: ['m1'] }],
});
eq('导入创建 1 个渠道', rt.channels, 1);
eq('渠道已落库', DBm.listChannels().length, 1);
eq('站点名已写', DBm.getSetting('site_name'), '导入的站点');
const rt2 = CFG.applyBundle({ kind: CFG.BUNDLE_KIND, version: 1, channels: [{ name: 'c1', models: ['m1', 'm2'] }] });
eq('按名合并不新建', DBm.listChannels().length, 1);
// listChannels() 返回的是原始行，models 是 JSON 字符串（server 层的 publicChannel 才解析）
eq('合并更新了模型', JSON.parse(DBm.listChannels()[0].models).length, 2);

const CLASH = `proxy-providers:
  pa:
    type: http
    url: "https://a.example/sub?token=T"
proxies:
  - { name: "流", type: ss, server: 1.1.1.1, port: 8388, cipher: aes-128-gcm, password: "p" }
  - name: 块
    type: vmess
    server: 2.2.2.2
    port: 443
    uuid: u-1
  - name: 废
    type: ss
rules:
  - MATCH,G
`;
const P = CFG.parseClashConfig(CLASH);
eq('Clash: 1 个 provider', P.providers.length, 1);
eq('Clash: provider 名', P.providers[0].name, 'pa');
eq('Clash: provider url', P.providers[0].url, 'https://a.example/sub?token=T');
eq('Clash: 2 个有效节点（废节点被跳过）', P.proxies.length, 2);
eq('Clash: 流式节点 server', P.proxies.find((x) => x.name === '流').server, '1.1.1.1');
eq('Clash: 流式节点 port 为数字', P.proxies.find((x) => x.name === '流').port, 8388);
eq('Clash: 块式节点 server', P.proxies.find((x) => x.name === '块').server, '2.2.2.2');
eq('Clash: 块式节点 uuid', P.proxies.find((x) => x.name === '块').uuid, 'u-1');
eq('Clash: 跳过统计', P.stats.skippedProxies, 1);
eq('Clash: 拒绝空内容', (() => { try { CFG.parseClashConfig(''); return false; } catch { return true; } })(), true);
eq('Clash: 拒绝非 Clash', (() => { try { CFG.parseClashConfig('hello'); return false; } catch { return true; } })(), true);

let saved = null;
const mr = CFG.mergeClashIntoSubs(P, { providers: [], manualProxies: [], excludedNodes: [], _参数: {} }, (o) => { saved = o; });
eq('Clash 合并：订阅 +1', mr.addedProviders, 1);
eq('Clash 合并：节点 +2', mr.addedProxies, 2);
eq('Clash 合并：写回了 saveSubs', saved && saved.manualProxies.length, 2);


/* ══════════════════════════════════════════════ 12) Responses 协议的两种兼容点 */
console.log('\n── 12) Responses 兼容 ──');

// OpenAI 的 /v1/responses 允许 input 是**纯字符串**（最常见写法），
// 只认数组会让上游收到空 messages 并 400。实测踩过。
eq('input 为纯字符串 → 1 条 user', B.responsesToChat({ model: 'm', input: '你好' }).messages.length, 1);
eq('input 纯字符串内容正确', B.responsesToChat({ model: 'm', input: '你好' }).messages[0].content, '你好');
eq('input 为字符串数组 → 2 条', B.responsesToChat({ model: 'm', input: ['a', 'b'] }).messages.length, 2);
eq('input 结构化 message → 1 条', B.responsesToChat({ model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }] }).messages.length, 1);
eq('instructions 变成 system', B.responsesToChat({ model: 'm', instructions: 'sys', input: 'hi' }).messages[0].role, 'system');
eq('input 缺失 → 0 条（不崩）', B.responsesToChat({ model: 'm' }).messages.length, 0);

// output_text 是官方 SDK 在客户端拼的字段，不在 HTTP 响应体里；
// 但很多第三方客户端直接读它，所以服务端补一份。
const onlyOutput = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'AB' }, { type: 'output_text', text: 'CD' }] }] };
eq('withOutputText 拼出 output_text', B.withOutputText(onlyOutput).output_text, 'ABCD');
eq('withOutputText 不覆盖已有值', B.withOutputText({ output_text: 'X', output: [] }).output_text, 'X');
eq('withOutputText 容忍空对象', B.withOutputText({}).output_text, '');
eq('withOutputText 容忍 null', B.withOutputText(null), null);
eq('withOutputText 跳过非 output_text 类型', B.withOutputText({ output: [{ content: [{ type: 'reasoning', text: 'no' }, { type: 'text', text: 'yes' }] }] }).output_text, 'yes');

/* ══════════════════════════════════════════════ 13) base_url 归一化 */
console.log('\n── 13) URL 归一化 ──');
const UPm = await import(pathToFileURL(path.join(ROOT, '01-管理面板', 'upstream.mjs')).href);
const chOf = (b) => ({ base_url: b, type: 'openai', api_key: 'k' });

// 核心回归：填了完整路径就不能再拼一次后缀
// （曾导致 .../chat/completions/chat/completions，上游回 404 HTML，
//   报错看起来像上游挂了，完全看不出是路径重复）
eq('完整 chat 地址不再重复',
  UPm.buildOpenAIRequest(chOf('https://a.com/v1/chat/completions'), { model: 'm', messages: [], stream: false }).url,
  'https://a.com/v1/chat/completions');
eq('responses 地址切回 chat',
  UPm.buildOpenAIRequest(chOf('https://a.com/v1/responses'), { model: 'm', messages: [], stream: false }).url,
  'https://a.com/v1/chat/completions');
eq('目录形式补全 chat',
  UPm.buildOpenAIRequest(chOf('https://a.com/v1'), { model: 'm', messages: [], stream: false }).url,
  'https://a.com/v1/chat/completions');
eq('目录带尾斜杠',
  UPm.buildOpenAIRequest(chOf('https://a.com/v1/'), { model: 'm', messages: [], stream: false }).url,
  'https://a.com/v1/chat/completions');
eq('只有主机',
  UPm.buildOpenAIRequest(chOf('https://a.com'), { model: 'm', messages: [], stream: false }).url,
  'https://a.com/chat/completions');
eq('空 base 走默认',
  UPm.buildOpenAIRequest(chOf(''), { model: 'm', messages: [], stream: false }).url,
  'https://api.openai.com/v1/chat/completions');
eq('buildResponsesRequest 归一 responses',
  UPm.buildResponsesRequest(chOf('https://a.com/v1/chat/completions'), { model: 'm', stream: false }).url,
  'https://a.com/v1/responses');
eq('桥接 chat 目标不重复',
  UPm.buildBridgedRequest(chOf('https://a.com/v1/chat/completions'), { model: 'm' }, 'chat').url,
  'https://a.com/v1/chat/completions');
eq('桥接 responses 目标不重复',
  UPm.buildBridgedRequest(chOf('https://a.com/v1/responses'), { model: 'm' }, 'responses').url,
  'https://a.com/v1/responses');
eq('baseUrlOf 去尾斜杠', UPm.baseUrlOf({ base_url: 'https://a.com/v1/' }), 'https://a.com/v1');
eq('endpointUrl 空渠道退回默认', UPm.endpointUrl({ base_url: '' }, 'chat', 'https://def/x'), 'https://def/x/chat/completions');
eq('completions（非 chat/completions）也剥离', UPm.baseUrlOf({ base_url: 'https://a.com/v1/completions' }), 'https://a.com/v1');

/* ══════════════════════════════════════════════ 14) OpenCode 会话池 */
console.log('\n── 14) 会话池 ──');
const SESSTMP = fsx.mkdtempSync(path.join(os.tmpdir(), 'ocgw-sesstest-'));
process.env.PANEL_DB = path.join(SESSTMP, 'panel.db');
const SESS = await import(pathToFileURL(path.join(ROOT, '01-管理面板', 'sessions.mjs')).href);

// 格式校验：ses_ + 12hex(低12位∈[0xfc0,0xfff]) + 14base62
eq('合法会话通过校验', SESS.isValidSession('ses_f60367c3affeasQdbdIYyP7kCs'), true);
eq('低12位越界被拒', SESS.isValidSession('ses_f60367c3a000asQdbdIYyP7kCs'), false);
eq('长度不对被拒', SESS.isValidSession('ses_abc'), false);
eq('非 ses_ 前缀被拒', SESS.isValidSession('xxx_f60367c3affeasQdbdIYyP7kCs'), false);
eq('describe 给出低12位', SESS.describe('ses_f60367c3affeasQdbdIYyP7kCs').low12, 0xffe);
eq('describe 拒绝坏格式', SESS.describe('nope').valid, false);

// 配置路径跟着 PANEL_DB 走（保证在可写的数据目录）
eq('配置文件与 panel.db 同目录', path.dirname(SESS.configPath()), SESSTMP);
eq('配置文件名为 opencode-sessions.json', path.basename(SESS.configPath()), 'opencode-sessions.json');

// 增删改查
eq('初始池子为空', SESS.list().length, 0);
eq('初始 current 为空', SESS.current(), '');
SESS.add('ses_f60367c3affeasQdbdIYyP7kCs', { note: 'a' });
SESS.add('ses_f5bbdbce3ffeX1jo8ZyHwkVev3', { note: 'b' });
eq('加两个', SESS.list().length, 2);
eq('第一个自动成为 active', SESS.current(), 'ses_f60367c3affeasQdbdIYyP7kCs');
eq('重复添加不重复入池', SESS.add('ses_f60367c3affeasQdbdIYyP7kCs').duplicate, true);
eq('重复后仍为 2 个', SESS.list().length, 2);
eq('拒绝非法 id', (() => { try { SESS.add('bad'); return false; } catch { return true; } })(), true);

SESS.setActive('ses_f5bbdbce3ffeX1jo8ZyHwkVev3');
eq('切换 active', SESS.current(), 'ses_f5bbdbce3ffeX1jo8ZyHwkVev3');

// 失败计数 + 轮换
SESS.markFail('ses_f5bbdbce3ffeX1jo8ZyHwkVev3');
const rotated = SESS.rotate('ses_f5bbdbce3ffeX1jo8ZyHwkVev3');
eq('轮换避开刚失败的', rotated, 'ses_f60367c3affeasQdbdIYyP7kCs');
SESS.markOk('ses_f60367c3affeasQdbdIYyP7kCs');
eq('markOk 后 failCount 归零', SESS.list().find((x) => x.id === 'ses_f60367c3affeasQdbdIYyP7kCs').failCount, 0);

// 持久化：重开文件还在
const onDisk = JSON.parse(fsx.readFileSync(SESS.configPath(), 'utf8'));
eq('已写盘', Array.isArray(onDisk.sessions) && onDisk.sessions.length === 2, true);
eq('盘上记录了 active', onDisk.active, 'ses_f60367c3affeasQdbdIYyP7kCs');

// 删除
eq('删除一个', SESS.remove('ses_f5bbdbce3ffeX1jo8ZyHwkVev3').removed, 1);
eq('删除后剩 1 个', SESS.list().length, 1);
eq('删掉 active 会自动选下一个', (() => { SESS.remove('ses_f60367c3affeasQdbdIYyP7kCs'); return SESS.current(); })(), '');

// 扫描本机：只验证不崩、返回结构对（结果多少取决于这台机器）
const scan = SESS.scanLocalSessions({ max: 5 });
eq('扫描返回结构正确', Array.isArray(scan.found) && Array.isArray(scan.scanned), true);
eq('扫描结果都合法', scan.found.every((x) => SESS.isValidSession(x)), true);
try { fsx.rmSync(SESSTMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

/* ══════════════════════════════════════════════ 15) 延迟分档 */
console.log('\n── 15) 延迟分档 ──');
const POOLm = await import(pathToFileURL(path.join(ROOT, '10-代理节点管理', 'pool.mjs')).href);
eq('默认档位 300/400/500', JSON.stringify(POOLm.delayTiers), JSON.stringify([300, 400, 500]));
eq('100ms 在第 0 档', POOLm.tierOf(100), 0);
eq('300ms 仍在第 0 档（含边界）', POOLm.tierOf(300), 0);
eq('301ms 落到第 1 档', POOLm.tierOf(301), 1);
eq('400ms 在第 1 档', POOLm.tierOf(400), 1);
eq('401ms 落到第 2 档', POOLm.tierOf(401), 2);
eq('500ms 在第 2 档', POOLm.tierOf(500), 2);
eq('501ms 落到第 3 档', POOLm.tierOf(501), 3);
eq('1333ms 在第 3 档', POOLm.tierOf(1333), 3);
eq('未知延迟（null）排最后', POOLm.tierOf(null), 3);
eq('未知延迟（0）排最后', POOLm.tierOf(0), 3);
eq('负数延迟排最后', POOLm.tierOf(-1), 3);

/* ══════════════════════════════════════════════ 16) 工具注入模式 */
console.log('\n── 16) 工具注入模式 ──');
const UPt = await import(pathToFileURL(path.join(ROOT, '01-管理面板', 'upstream.mjs')).href);
const CLIENT_T = [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } } }];
const mkCh = (mode) => ({ base_url: 'https://opencode.ai/inference/v1/chat/completions', type: 'opencode', api_key: 'public', extra: mode ? { tool_mode: mode } : {} });
const namesOf = (b) => b.body.tools.map((t) => t.function.name);

// 默认是 client 模式：客户端给什么就用什么，只额外补一个 read 满足门禁
eq('默认模式是 client', UPt.toolMode(mkCh()), 'client');
const bc = UPt.buildRequest(mkCh(), { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: CLIENT_T, stream: false });
eq('client 模式只发客户端的工具 + read', namesOf(bc).join(','), 'get_weather,read');
eq('client 模式不会注入 bash', namesOf(bc).includes('bash'), false);
eq('client 模式不会注入 edit', namesOf(bc).includes('edit'), false);

// 客户端不给 tools → 退回模板（否则门禁过不了）
const bn = UPt.buildRequest(mkCh(), { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
eq('客户端不给 tools 时退回模板', namesOf(bn).length >= 12, true);
eq('退回模板时含 read', namesOf(bn).includes('read'), true);

// merge 模式 = 旧行为（模板 + 客户端）
const bm = UPt.buildRequest(mkCh('merge'), { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: CLIENT_T, stream: false });
eq('merge 模式会合并成 13 个', namesOf(bm).length, 13);
eq('merge 模式含 bash', namesOf(bm).includes('bash'), true);

// template 模式 = 只用模板
const bt = UPt.buildRequest(mkCh('template'), { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: CLIENT_T, stream: false });
eq('template 模式只有模板工具', namesOf(bt).includes('get_weather'), false);
eq('template 模式含 read', namesOf(bt).includes('read'), true);

// 无论哪种模式，read 都必须在（门禁硬要求）
for (const mode of ['client', 'merge', 'template']) {
  const b = UPt.buildRequest(mkCh(mode), { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: CLIENT_T, stream: false });
  eq(`${mode} 模式都保证有 read`, namesOf(b).includes('read'), true);
}

// 客户端自己就带 read 时不能重复（上游对重名工具会 400）
const withRead = [...CLIENT_T, { type: 'function', function: { name: 'read', description: 'r', parameters: { type: 'object', properties: {} } } }];
const br = UPt.buildRequest(mkCh(), { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: withRead, stream: false });
eq('客户端自带 read 时不重复', namesOf(br).filter((x) => x === 'read').length, 1);

// 非法模式回退到 client
eq('非法模式回退 client', UPt.toolMode(mkCh('bogus')), 'client');

console.log(`\n单元测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
