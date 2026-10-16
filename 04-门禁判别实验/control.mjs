// CRITICAL CONTROL: is the gate stateful? Replay the exact V0 verbatim request several times.
import fs from 'node:fs';
const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));

async function t(name, headers, body) {
  try {
    const r = await fetch(cap.url, { method: 'POST', headers, body });
    const txt = (await r.text()).slice(0, 120).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); return -1; }
}

console.log('captured session-id =', cap.headers['x-opencode-session-id']);
console.log('captured request-id =', cap.headers['x-opencode-request']);
for (let i = 1; i <= 3; i++) {
  await t(`Z${i} verbatim repeat #${i}`, cap.headers, cap.body);
}
