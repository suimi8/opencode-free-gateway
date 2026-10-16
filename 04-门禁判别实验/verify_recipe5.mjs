// 第五轮：UA 版本门禁（426 是第四轮才发现的**第 5 个条件**）
//
// 第四轮意外结果：
//   opencode/1.2.3  -> 426 "OpenCode 1.18.0 or newer is required to use the free tier"
//   opencode/1.2    -> 426
//   opencode/1      -> 403（单段版本解析不了，落回形状门禁）
//   opencode/1.19.2 -> 200
// ⇒ UA 里的版本号被解析，且必须 ≥ 1.18.0，否则返回 426（不是 403）。
//
// 本轮钉死 1.18.0 这个边界。
import fs from 'node:fs';

const URL = 'https://opencode.ai/inference/v1/chat/completions';
const RAW = fs.readFileSync(import.meta.dirname + '/captured_body.json', 'utf8');
const GOOD = 'ses_ebcf32130ffe7wJ1T06CSp2AP5';

const headers = (ua) => ({
  authorization: 'Bearer public',
  'content-type': 'application/json',
  'user-agent': ua,
  'x-opencode-client': 'desktop',
  'x-opencode-project': 'global',
  'x-opencode-request': 'msg_1430cdf990011XnerlxbTEQ1Ei',
  'x-opencode-session': GOOD,
  'x-opencode-session-id': GOOD,
});

const cases = [
  ['opencode/1.18.0',        '期望 200 —— 声明的下界'],
  ['opencode/1.17.9',        '期望 426 —— 刚好低于下界'],
  ['opencode/1.18',          '两段式是否等价 1.18.0'],
  ['opencode/1.19.2',        '基线（当前模板用的版本）'],
  ['opencode/1.19.2 abc',    '带尾巴'],
  ['opencode/99.0.0',        '远高于下界'],
  ['opencode/1.18.0-beta.1', '预发布后缀'],
  ['opencode/v1.19.2',       '带 v 前缀'],
  ['opencode/2',             '单段（应 403）'],
];

async function run([ua, why]) {
  let status = 0, note = '';
  try {
    const r = await fetch(URL, { method: 'POST', headers: headers(ua), body: RAW, signal: AbortSignal.timeout(120000) });
    status = r.status;
    const txt = await r.text();
    note = status === 200 ? 'STREAM OK'
         : (txt.match(/"message":"([^"]{0,70})/)?.[1] ?? txt.slice(0, 70));
  } catch (e) { note = 'EXC ' + e.message; }
  const mark = status === 200 ? '\x1b[32m200 通过\x1b[0m'
             : status === 426 ? '\x1b[33m426 版本过低\x1b[0m'
             : status === 403 ? '\x1b[31m403 被拒\x1b[0m' : String(status);
  console.log(`[${ua.padEnd(24)}] ${why}`);
  console.log(`    -> ${mark}   ${note}`);
  return { ua, status };
}

console.log('门禁第 5 条件：UA 最低版本 —— 第五轮\n');
const out = [];
for (const c of cases) out.push(await run(c));
console.log('\n══ 汇总 ══');
for (const r of out) console.log(`  ${String(r.status).padEnd(4)} ${r.ua}`);
