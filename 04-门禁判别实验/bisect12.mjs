// Confirm the low12 range boundary and the minimal required header set.
import fs from 'node:fs';
const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));
const H = cap.headers, FULL = cap.body;
const TAIL = H['x-opencode-session-id'].slice(16);
const UA = H['user-agent'], CT = H['content-type'];
const sid = (hexv) => 'ses_' + hexv + TAIL;

async function t(name, headers) {
  try {
    const r = await fetch(cap.url, { method: 'POST', headers, body: FULL });
    const txt = (await r.text()).slice(0, 45).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); return -1; }
}

const base = (hexv, extra) => ({ 'content-type': CT, 'user-agent': UA, 'x-opencode-session-id': sid(hexv), ...extra });

console.log('--- low12 boundary (high bits forged to 0) ---');
for (const h of ['000000000ff1', '000000000ffc', '000000000fef', '000000000ff0']) {
  await t(`low12=0x${h.slice(-3)}`, base(h, { 'x-opencode-session': sid(h) }));
}
console.log('--- minimal header set (forged low12=ffe) ---');
await t('L1 UA+sid+session (no request)', base('000000000ffe', { 'x-opencode-session': sid('000000000ffe') }));
await t('L2 UA+sid+request (no session)', base('000000000ffe', { 'x-opencode-request': 'msg_0000000000001XnerlxbTEQ1Ei' }));
await t('L3 UA+sid only', base('000000000ffe', {}));
