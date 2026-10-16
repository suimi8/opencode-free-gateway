// 免费层门禁「最小配方」判定 —— 单变量消融实验
//
// 从一份已验证可用的请求出发，每次只破坏一个条件，看是否变 403。
// 目的：回答「是不是只要 header 里加个 opencode 参数就行」。
//
//   node verify_recipe.mjs           跑全部变体
//   node verify_recipe.mjs --short   只跑关键几个（省额度）
//
// ⚠️ 成功的调用会消耗**所有免费模型共用的每日额度**。403 的变体不消耗。
import fs from 'node:fs';

const URL = 'https://opencode.ai/inference/v1/chat/completions';
const RAW = fs.readFileSync(import.meta.dirname + '/captured_body.json', 'utf8');
const BODY_OBJ = JSON.parse(RAW);

// 真实客户端捕获到的完整头
const BASE_HEADERS = {
  authorization: 'Bearer public',
  'content-type': 'application/json',
  'user-agent': 'opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24',
  'x-opencode-client': 'desktop',
  'x-opencode-project': 'global',
  'x-opencode-request': 'msg_1430cdf990011XnerlxbTEQ1Ei',
  'x-opencode-session': 'ses_ebcf32130ffe7wJ1T06CSp2AP5',
  'x-opencode-session-id': 'ses_ebcf32130ffe7wJ1T06CSp2AP5',
};

const SID_OK = 'ses_ebcf32130ffe7wJ1T06CSp2AP5';   // low12 = 0xffe ∈ [0xfc0,0xfff]
const SID_BAD = 'ses_ebcf321300007wJ1T06CSp2AP5';  // low12 = 0x000 不在区间

// 把 body 缩到「最小」：只留一条 user 消息，去掉 system 与 tools
const MINI_BODY = JSON.stringify({
  model: BODY_OBJ.model,
  max_tokens: 32,
  messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
  stream: true,
});

// 非流式版本：用 JSON 改，不依赖原始文本里的空格格式
const NO_STREAM_BODY = JSON.stringify({ ...BODY_OBJ, stream: false });

const variants = [
  // [标签, 说明, headers 覆盖, body 覆盖]
  ['00 基线（4 条条件全满足）', '期望 200 —— 证明测试链路本身有效',
    {}, RAW],

  ['01 去掉 user-agent 的 opencode/ 前缀', '换成浏览器 UA：门禁看 UA 形状',
    { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0 Safari/537.36' }, RAW],

  ['02 去掉 x-opencode-session-id', '只留 x-opencode-session',
    { 'x-opencode-session-id': undefined }, RAW],

  ['03 去掉 x-opencode-session', '只留 x-opencode-session-id',
    { 'x-opencode-session': undefined }, RAW],

  ['04 两个 session 头都去掉', '只剩 UA + 完整 body',
    { 'x-opencode-session-id': undefined, 'x-opencode-session': undefined }, RAW],

  ['05 session id 的 low12 落在区间外', '0x000 代替 0xffe',
    { 'x-opencode-session-id': SID_BAD, 'x-opencode-session': SID_BAD }, RAW],

  ['06 body.stream = false', '非流式',
    {}, NO_STREAM_BODY],

  ['07 只加 1 个头（x-opencode-session-id），其余照旧',
    '验证「加一个 opencode 头就够了」是否成立',
    { 'x-opencode-session': undefined,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0 Safari/537.36' }, RAW],

  ['08 最小 body（无 system / 无 tools）', '完整头，但 body 砍到最小',
    {}, MINI_BODY],

  ['09 去掉 authorization', '证明 public 不是必需',
    { authorization: undefined }, RAW],

  ['10 去掉 request / client / project 三个头',
    '只留 UA + 两个 session 头，看是否仍通过',
    { 'x-opencode-request': undefined, 'x-opencode-client': undefined, 'x-opencode-project': undefined }, RAW],
];

const SHORT = process.argv.includes('--short');
const picked = SHORT ? variants.filter(v => /^0[0-7]/.test(v[0])) : variants;

async function run([label, why, overrides, body]) {
  const headers = { ...BASE_HEADERS };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete headers[k]; else headers[k] = v;
  }
  const t0 = Date.now();
  let status = 0, note = '';
  try {
    const r = await fetch(URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(120000) });
    status = r.status;
    const txt = await r.text();
    if (status === 200) {
      note = 'STREAM OK';
    } else {
      // 只取错误类别，避免打印整段响应
      const m = txt.match(/"name"\s*:\s*"([^"]+)"|"message"\s*:\s*"([^"]{0,90})/);
      note = (txt.match(/"name":"([^"]+)"/)?.[1] || '') +
             (txt.match(/"message":"([^"]{0,80})/)?.[1] ? ' | ' + txt.match(/"message":"([^"]{0,80})/)[1] : '') ||
             txt.slice(0, 90);
    }
  } catch (e) { note = 'EXC ' + e.message; }
  const verdict = status === 200 ? '\x1b[32m200 通过\x1b[0m' : status === 403 ? '\x1b[31m403 被拒\x1b[0m' : String(status);
  console.log(`[${label}]`);
  console.log(`    目的 : ${why}`);
  console.log(`    结果 : ${verdict}   (${Date.now() - t0}ms)  ${note}`);
  console.log('');
  return { label, status };
}

console.log('免费层门禁最小配方判定');
console.log('URL :', URL);
console.log('body:', RAW.length, '字符（基线） /', MINI_BODY.length, '字符（最小）');
console.log('注：只有 200 的变体消耗每日额度；403 不消耗。');
console.log('');

const results = [];
for (const v of picked) results.push(await run(v));

console.log('══ 汇总 ══');
for (const r of results) console.log(`  ${String(r.status).padEnd(4)} ${r.label}`);
