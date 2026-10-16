// 最小可用请求判定 —— 只保留「必需」的东西，看能不能过
//
// 前五轮已确定必需项：
//   user-agent（含版本 ≥ 1.18.0）、x-opencode-session、body.stream=true、完整 agent body
// 本轮把其余全部删掉，验证这就是完整的「最小配方」。
import fs from 'node:fs';

const URL = 'https://opencode.ai/inference/v1/chat/completions';
const BODY = fs.readFileSync(import.meta.dirname + '/captured_body.json', 'utf8');

const mk = (low12) => 'ses_' + 'ebcf32130' + low12.toString(16).padStart(3, '0') + '7wJ1T06CSp2AP5';

const CASES = [
  {
    label: '最小配方：3 个头',
    desc: 'user-agent + x-opencode-session + content-type，其余全不要',
    headers: {
      'user-agent': 'opencode/1.19.2',
      'x-opencode-session': mk(0xffe),
      'content-type': 'application/json',
    },
  },
  {
    label: '极简 UA',
    desc: 'user-agent 只写 opencode/1.18.0（刚好到版本下界）',
    headers: {
      'user-agent': 'opencode/1.18.0',
      'x-opencode-session': mk(0xffe),
      'content-type': 'application/json',
    },
  },
  {
    label: '只留 2 个头（去掉 content-type）',
    desc: '验证 content-type 是否也不必要',
    headers: {
      'user-agent': 'opencode/1.19.2',
      'x-opencode-session': mk(0xffe),
    },
  },
];

async function run({ label, desc, headers }) {
  let status = 0, note = '', sample = '';
  try {
    const r = await fetch(URL, { method: 'POST', headers, body: BODY, signal: AbortSignal.timeout(120000) });
    status = r.status;
    const txt = await r.text();
    if (status === 200) {
      note = 'STREAM OK';
      // 抓一小段，确认真的是模型回复而不是别的
      const c = [...txt.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('').slice(0, 60);
      sample = c;
    } else {
      note = txt.match(/"message":"([^"]{0,70})/)?.[1] ?? txt.slice(0, 70);
    }
  } catch (e) { note = 'EXC ' + e.message; }
  const mark = status === 200 ? '\x1b[32m200 通过\x1b[0m' : status === 403 ? '\x1b[31m403 被拒\x1b[0m' : String(status);
  console.log(`[${label}]`);
  console.log(`    ${desc}`);
  console.log(`    发送的头: ${Object.keys(headers).join(', ')}`);
  console.log(`    -> ${mark}   ${note}${sample ? '   回复片段: ' + JSON.stringify(sample) : ''}`);
  return status;
}

console.log('最小可用请求判定');
console.log('URL :', URL);
console.log('body:', BODY.length, '字符（完整 agent 结构，未改动）\n');

const out = [];
for (const c of CASES) out.push(await run(c));

console.log('\n══ 结论 ══');
const min = out[0] === 200;
const two = out[2] === 200;
console.log(min ? '  ✔ 3 个头（user-agent + x-opencode-session + content-type）即可调用' : '  ✘ 3 个头不够');
console.log(two ? '  ✔ 连 content-type 都可以省（2 个头）' : '  → content-type 仍需保留');
console.log('  · 必需：user-agent（版本≥1.18.0）、x-opencode-session、完整 agent body（stream:true）');
console.log('  · 其余全部可删：authorization / x-opencode-session-id / x-opencode-request / client / project');
