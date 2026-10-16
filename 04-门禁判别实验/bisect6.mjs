// Is the 12-hex session-id prefix a recency check? Probe deltas around the real value.
import fs from 'node:fs';
const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));
const H = cap.headers, FULL = cap.body;
const REAL_HEX = H['x-opencode-session-id'].slice(4, 16);
const TAIL = H['x-opencode-session-id'].slice(16);
const n = BigInt('0x' + REAL_HEX);
console.log('real hex', REAL_HEX, '=', n.toString(), 'tail', TAIL);
console.log('real hex as /4096 =', (n / 4096n).toString());
console.log('now ms (approx)', Date.now(), '| MAX_SAFE-now =', (9007199254740991n - BigInt(Date.now())).toString());

const mk = (hexv) => {
  const ses = 'ses_' + hexv + TAIL;
  return { ...H, 'x-opencode-session-id': ses, 'x-opencode-session': ses };
};
const hx = (v) => v.toString(16).padStart(12, '0').slice(-12);

async function t(name, headers) {
  try {
    const r = await fetch(cap.url, { method: 'POST', headers, body: FULL });
    const txt = (await r.text()).slice(0, 70).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); return -1; }
}

await t('C0 control real hex', mk(REAL_HEX));
await t('D1 hex + 0x1000', mk(hx(n + 0x1000n)));
await t('D2 hex - 0x1000', mk(hx(n - 0x1000n)));
await t('D3 hex - 0x100000000 (~1.1e9)', mk(hx(n - 0x100000000n)));
await t('D4 hex + 0x100000000 (~1.1e9)', mk(hx(n + 0x100000000n)));
await t('D5 hex = 000000000001', mk('000000000001'));
await t('D6 hex = fffffffffffe', mk('fffffffffffe'));
await t('D7 random 12 hex', mk(hx(BigInt(Math.floor(Math.random() * 2 ** 48)))));
