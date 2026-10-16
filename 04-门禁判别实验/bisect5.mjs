// Which part of the id is validated? The 12-hex timestamp prefix, or the random tail?
import fs from 'node:fs';
const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));
const H = cap.headers, FULL = cap.body;
const SES = H['x-opencode-session-id'], MSG = H['x-opencode-request'];
console.log('SES', SES, 'MSG', MSG);

const mk = (ses, msg) => ({ ...H, 'x-opencode-session-id': ses, 'x-opencode-session': ses, 'x-opencode-request': msg });
const A = mk('ses_ebcf32130ffeZZZZZZZZZZZZZZ', MSG);   // session tail mutated, real hex
const B = mk('ses_0000000000007wJ1T06CSp2AP5', MSG);   // session hex mutated, real tail
const C = mk(SES, 'msg_1430cdf99001ZZZZZZZZZZZZZZ');   // request tail mutated, real hex
const D = mk(SES, 'msg_0000000000001XnerlxbTEQ1Ei');   // request hex mutated, real tail

async function t(name, headers) {
  try {
    const r = await fetch(cap.url, { method: 'POST', headers, body: FULL });
    const txt = (await r.text()).slice(0, 90).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); return -1; }
}

await t('E control real ids', mk(SES, MSG));
await t('A session-id TAIL mutated (real hex)', A);
await t('B session-id HEX mutated (real tail)', B);
await t('C request-id TAIL mutated (real hex)', C);
await t('D request-id HEX mutated (real tail)', D);
