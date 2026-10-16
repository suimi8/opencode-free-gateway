// 第二轮：把「最小配方」钉到精确边界
//
// 第一轮（verify_recipe.mjs）的意外发现：
//   去掉 x-opencode-session-id  → 仍然 200  ⇒ 这个头**不是必需的**
//   去掉 x-opencode-session     → 403       ⇒ 这个头必需
// 这一轮确认：session-id 是否完全不校验、low12 边界、UA 前缀是否大小写敏感。
import fs from 'node:fs';

const URL = 'https://opencode.ai/inference/v1/chat/completions';
const RAW = fs.readFileSync(import.meta.dirname + '/captured_body.json', 'utf8');

const H = {
  authorization: 'Bearer public',
  'content-type': 'application/json',
  'user-agent': 'opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24',
  'x-opencode-client': 'desktop',
  'x-opencode-project': 'global',
  'x-opencode-request': 'msg_1430cdf990011XnerlxbTEQ1Ei',
  'x-opencode-session': 'ses_ebcf32130ffe7wJ1T06CSp2AP5',
  'x-opencode-session-id': 'ses_ebcf32130ffe7wJ1T06CSp2AP5',
};

// 按 low12 造一个形状合法的 session id：ses_ + 9 hex + 3 hex(low12) + 14 base62
const mkSes = (low12) => 'ses_' + 'ebcf32130' + low12.toString(16).padStart(3, '0') + '7wJ1T06CSp2AP5';

const cases = [
  ['A  x-opencode-session-id 塞垃圾字符串（session 正常）',
    '若仍 200 ⇒ session-id 完全不校验',
    { 'x-opencode-session-id': 'not-a-session-at-all' }],

  ['B  x-opencode-session-id 完全不存在（session 正常）',
    '重复第一轮的 02，确认可复现',
    { 'x-opencode-session-id': undefined }],

  ['C  session 的 low12 = 0x000（session-id 正常）',
    '期望 403 ⇒ 形状校验在 session 上',
    { 'x-opencode-session': mkSes(0x000) }],

  ['D  session 的 low12 = 0xfbf（区间下界外一格）',
    '期望 403',
    { 'x-opencode-session': mkSes(0xfbf) }],

  ['E  session 的 low12 = 0xfc0（区间下界）',
    '期望 200 ⇒ 下界成立',
    { 'x-opencode-session': mkSes(0xfc0) }],

  ['F  session 的 low12 = 0xfff（区间上界）',
    '期望 200 ⇒ 上界成立',
    { 'x-opencode-session': mkSes(0xfff) }],

  ['G  session 用 UUID（无 ses_ 前缀）',
    '期望 403 ⇒ 前缀必需',
    { 'x-opencode-session': '550e8400-e29b-41d4-a716-446655440000' }],

  ['H  session 尾巴长度不对（少 2 位 base62）',
    '期望 403 ⇒ 长度也校验',
    { 'x-opencode-session': 'ses_ebcf32130ffe' + '7wJ1T06CSp2AP'.slice(0, 12) }],

  ['I  UA 改成 OpenCode/1.19.2（首字母大写）',
    '期望 403 ⇒ 大小写敏感',
    { 'user-agent': 'OpenCode/1.19.2 ai-sdk/provider-utils/4.0.23' }],

  ['J  UA 改成 xxopencode/1.19.2（前缀不对）',
    '期望 403 ⇒ 必须**以** opencode/ 开头',
    { 'user-agent': 'xxopencode/1.19.2' }],

  ['K  UA 只有 opencode/ （前缀之后为空）',
    '期望 200 ⇒ 前缀之后内容不校验',
    { 'user-agent': 'opencode/' }],
];

async function run([label, why, overrides]) {
  const headers = { ...H };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete headers[k]; else headers[k] = v;
  }
  let status = 0, note = '';
  try {
    const r = await fetch(URL, { method: 'POST', headers, body: RAW, signal: AbortSignal.timeout(120000) });
    status = r.status;
    const txt = await r.text();
    note = status === 200 ? 'STREAM OK' : (txt.match(/"message":"([^"]{0,70})/)?.[1] ?? txt.slice(0, 70));
  } catch (e) { note = 'EXC ' + e.message; }
  const mark = status === 200 ? '\x1b[32m200 通过\x1b[0m' : status === 403 ? '\x1b[31m403 被拒\x1b[0m' : String(status);
  console.log(`[${label}]`);
  console.log(`    ${why}`);
  console.log(`    -> ${mark}   ${note}`);
  return { label: label.slice(0, 2), status };
}

console.log('门禁最小配方 —— 第二轮（边界与冗余头）');
console.log('只有 200 的用例消耗额度。\n');

const out = [];
for (const c of cases) out.push(await run(c));

console.log('══ 汇总 ══');
for (const r of out) console.log(`  ${String(r.status).padEnd(4)} ${r.label}`);
