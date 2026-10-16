// 第三轮：隔离「两个 session 头各自被校验什么」
//
// 前两轮出现互相矛盾的现象，需要精确隔离：
//   R1#02 session-id 缺失 + session 合法          -> 200
//   R1#03 session   缺失 + session-id 合法        -> 403   ⇒ session 必需
//   R2#A  session-id 垃圾 + session 合法          -> 403   ⇒ session-id 存在时被校验
//   R2#C  session low12=0x000 + session-id=0xffe  -> 200   ⇒ session 的 low12 不校验？！
//   R1#05 两个都 low12=0x000                      -> 403
//
// 假设 H：服务端取「session-id 优先、否则 session」作为被校验值，
//         要求存在至少一个，且被取到的那个必须符合完整形状（含 low12）。
// 本轮逐条证伪/证实 H。
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
const mkSes = (low12) => 'ses_' + 'ebcf32130' + low12.toString(16).padStart(3, '0') + '7wJ1T06CSp2AP5';
const GOOD = mkSes(0xffe), LOW0 = mkSes(0x000), LOWFBF = mkSes(0xfbf);

const cases = [
  ['1  session-id low12=0x000 + session=合法',
    '若 403 ⇒ session-id 的 low12 被校验（R1#05 的 403 来自它）',
    { 'x-opencode-session-id': LOW0, 'x-opencode-session': GOOD }],

  ['2  session-id 缺失 + session low12=0x000',
    '假设 H 的判决点：若 403 ⇒ 回退到 session 后也校验 low12；若 200 ⇒ session 的值根本不校验',
    { 'x-opencode-session-id': undefined, 'x-opencode-session': LOW0 }],

  ['3  session-id 缺失 + session low12=0xfbf',
    '同上，另一侧',
    { 'x-opencode-session-id': undefined, 'x-opencode-session': LOWFBF }],

  ['4  session-id=合法 + session=坏前缀(UUID)',
    '若 403 ⇒ 两个头**都**要被形状校验',
    { 'x-opencode-session-id': GOOD, 'x-opencode-session': '550e8400-e29b-41d4-a716-446655440000' }],

  ['5  session-id=合法 + session=长度不对',
    '同上，长度维度',
    { 'x-opencode-session-id': GOOD, 'x-opencode-session': 'ses_ebcf32130ffe7wJ1T06CSp2A' }],

  ['6  UA = "opencode/" （重跑 K，上轮 fetch 异常）',
    '前缀之后为空是否可接受',
    { 'user-agent': 'opencode/' }],

  ['7  UA = "OPEnCoDe/9" （混合大小写）',
    '若 200 ⇒ UA 前缀匹配忽略大小写（I 的 200 不是偶然）',
    { 'user-agent': 'OPEnCoDe/9' }],

  ['8  UA = "opencode" （无斜杠）',
    '若 403 ⇒ 斜杠是前缀的一部分',
    { 'user-agent': 'opencode' }],

  ['9  UA = "x-opencode/1"',
    'R2#J 的对照：确认不是「包含 opencode/」而是「以 opencode/ 开头」',
    { 'user-agent': 'x-opencode/1' }],

  ['10 session 与 session-id 都合法但值不同',
    '两者不一致是否被拒（防止它们必须相等）',
    { 'x-opencode-session-id': mkSes(0xfc0), 'x-opencode-session': mkSes(0xfff) }],
];

async function run([label, why, overrides]) {
  const headers = { ...H };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete headers[k]; else headers[k] = v;
  }
  let status = 0, note = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(URL, { method: 'POST', headers, body: RAW, signal: AbortSignal.timeout(120000) });
      status = r.status;
      const txt = await r.text();
      note = status === 200 ? 'STREAM OK' : (txt.match(/"message":"([^"]{0,60})/)?.[1] ?? txt.slice(0, 60));
      break;
    } catch (e) { status = 0; note = 'EXC ' + e.message + (attempt === 1 ? ' (重试)' : ''); }
  }
  const mark = status === 200 ? '\x1b[32m200 通过\x1b[0m' : status === 403 ? '\x1b[31m403 被拒\x1b[0m' : String(status);
  console.log(`[${label}]`);
  console.log(`    ${why}`);
  console.log(`    -> ${mark}   ${note}`);
  return { label: label.split(' ')[0], status };
}

console.log('门禁最小配方 —— 第三轮（隔离两个 session 头）\n');
const out = [];
for (const c of cases) out.push(await run(c));
console.log('══ 汇总 ══');
for (const r of out) console.log(`  ${String(r.status).padEnd(4)} ${r.label}`);
