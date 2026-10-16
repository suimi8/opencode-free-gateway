// 用「真实完整头」直接发起请求 —— 从普通 Node 进程发出，不在引擎进程内。
import fs from 'node:fs';
const BODY = fs.readFileSync(import.meta.dirname + '/captured_body.json', 'utf8');
const URL = 'https://opencode.ai/inference/v1/chat/completions';

// 引擎捕获到的逐字完整头（8 个，一个不少）
const REAL = {
  authorization: 'Bearer public',
  'content-type': 'application/json',
  'user-agent': 'opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24',
  'x-opencode-client': 'desktop',
  'x-opencode-project': 'global',
  'x-opencode-request': 'msg_1430cdf990011XnerlxbTEQ1Ei',
  'x-opencode-session': 'ses_ebcf32130ffe7wJ1T06CSp2AP5',
  'x-opencode-session-id': 'ses_ebcf32130ffe7wJ1T06CSp2AP5',
};

async function send(label, headers) {
  const r = await fetch(URL, { method: 'POST', headers, body: BODY });
  const t = await r.text();
  const ok = t.includes('"type":"error"') ? t.slice(0, 120) : 'STREAM OK :: ' + t.slice(0, 80).replace(/\n/g, '');
  console.log(`[${label}] HTTP ${r.status} :: ${ok}`);
}

console.log('headers sent:', Object.keys(REAL).join(', '));
await send('A 逐字完整头 + 捕获的 id', REAL);

// B：把 session/request 换成用户 app 里真实存在的 id（来自 opencode.db）
await send('B 同一套头 + 真实 app 的 session/msg id', {
  ...REAL,
  'x-opencode-session-id': 'ses_ebd0f492affeKMIjnAvQdf9CVV',
  'x-opencode-session': 'ses_ebd0f492affeKMIjnAvQdf9CVV',
  'x-opencode-request': 'msg_1431884f3001NWKLOEDddwF0Yl',
});

// C：同上但去掉 authorization（证明 public 本身不是关键）
const noAuth = { ...REAL };
delete noAuth.authorization;
await send('C 同上但删掉 authorization', {
  ...noAuth,
  'x-opencode-session-id': 'ses_ebd0f492affeKMIjnAvQdf9CVV',
  'x-opencode-session': 'ses_ebd0f492affeKMIjnAvQdf9CVV',
});
