// 第四轮：修正前两轮的混淆，把边界放到正确的头上
//
// 前三轮已建立的一致模型：
//   1) user-agent  需匹配 ^opencode/<x.y.z>（大小写不敏感）
//   2) x-opencode-session    必需，形状 ses_ + 12hex + 14base62
//   3) x-opencode-session-id 可选；**若存在也必须合法**
//   4) low12 ∈ [0xfc0,0xfff] 只在「session-id 若存在则看它，否则看 session」上校验
//   （R2 的 E/F 边界用例被污染了：当时 session-id 一直是 0xffe 的好值，
//     所以 200 并不能证明 session 的边界成立。）
//
// 本轮：把边界值放到 session-id 上重测；并用 4 个 UA 变体确认版本号要求。
import fs from 'node:fs';

const URL = 'https://opencode.ai/inference/v1/chat/completions';
const RAW = fs.readFileSync(import.meta.dirname + '/captured_body.json', 'utf8');

const GOOD = 'ses_ebcf32130ffe7wJ1T06CSp2AP5';
const mk = (low12) => 'ses_' + 'ebcf32130' + low12.toString(16).padStart(3, '0') + '7wJ1T06CSp2AP5';

const mkHeaders = (sid, ses, ua) => {
  const h = {
    authorization: 'Bearer public',
    'content-type': 'application/json',
    'user-agent': ua ?? 'opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24',
    'x-opencode-client': 'desktop',
    'x-opencode-project': 'global',
    'x-opencode-request': 'msg_1430cdf990011XnerlxbTEQ1Ei',
  };
  if (ses !== null) h['x-opencode-session'] = ses ?? GOOD;
  if (sid !== null) h['x-opencode-session-id'] = sid ?? GOOD;
  return h;
};

const cases = [
  // ── A. low12 边界（放在 session-id 上，session 保持合法）──
  ['B0  session-id low12=0xffe', '基线，期望 200', mkHeaders(mk(0xffe), GOOD)],
  ['B1  session-id low12=0xfff', '期望 200（上界）', mkHeaders(mk(0xfff), GOOD)],
  ['B2  session-id low12=0xfc0', '期望 200（下界）', mkHeaders(mk(0xfc0), GOOD)],
  ['B3  session-id low12=0xfbf', '期望 403（下界外一格）', mkHeaders(mk(0xfbf), GOOD)],
  ['B4  session-id low12=0x000', '期望 403（远离区间）', mkHeaders(mk(0x000), GOOD)],

  // ── B. UA 版本号要求 ──
  ['U1  UA=opencode/1.2.3', '期望 200（完整 x.y.z）', mkHeaders(GOOD, GOOD, 'opencode/1.2.3')],
  ['U2  UA=opencode/1', '期望 403（无点分版本）', mkHeaders(GOOD, GOOD, 'opencode/1')],
  ['U3  UA=opencode/1.2', '期望 403（只有两段）', mkHeaders(GOOD, GOOD, 'opencode/1.2')],
  ['U4  UA=OpenCode/1.19.2 ai-sdk/x', '期望 200（大小写不敏感）', mkHeaders(GOOD, GOOD, 'OpenCode/1.19.2 ai-sdk/x')],
  ['U5  UA=opencode/1.2.3 ', '期望 200（尾部空格无影响）', mkHeaders(GOOD, GOOD, 'opencode/1.2.3 ')],

  // ── C. session-id 缺失时 low12 是否回退到 session ──
  ['F1  session-id 缺失 + session low12=0xfc0', '期望 200（回退成立）', mkHeaders(null, mk(0xfc0))],
  ['F2  session-id 缺失 + session low12=0xfbf', '期望 403（回退后同样拒绝）', mkHeaders(null, mk(0xfbf))],
];

async function run([label, why, headers]) {
  let status = 0, note = '';
  for (let a = 1; a <= 2; a++) {
    try {
      const r = await fetch(URL, { method: 'POST', headers, body: RAW, signal: AbortSignal.timeout(120000) });
      status = r.status;
      const txt = await r.text();
      note = status === 200 ? 'STREAM OK' : (txt.match(/"message":"([^"]{0,55})/)?.[1] ?? txt.slice(0, 55));
      break;
    } catch (e) { status = 0; note = 'EXC ' + e.message; }
  }
  const mark = status === 200 ? '\x1b[32m200 通过\x1b[0m' : status === 403 ? '\x1b[31m403 被拒\x1b[0m' : String(status);
  console.log(`[${label}]  ${why}`);
  console.log(`    -> ${mark}   ${note}`);
  return { label: label.split(' ')[0], status };
}

console.log('门禁最小配方 —— 第四轮（修正边界归属 + UA 版本号）\n');
const out = [];
for (const c of cases) out.push(await run(c));
console.log('\n══ 汇总 ══');
for (const r of out) console.log(`  ${String(r.status).padEnd(4)} ${r.label}`);
