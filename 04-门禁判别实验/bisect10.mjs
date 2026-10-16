// Decisive test: is the gate literally the low 12 bits of the session-id hex?
import fs from 'node:fs';
const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));
const H = cap.headers, FULL = cap.body;
const REAL = H['x-opencode-session-id'];
const TAIL = REAL.slice(16);
const mk = (hexv) => { const s = 'ses_' + hexv + TAIL; return { ...H, 'x-opencode-session-id': s, 'x-opencode-session': s }; };

async function t(name, hexv) {
  const r = await fetch(cap.url, { method: 'POST', headers: mk(hexv), body: FULL });
  const txt = (await r.text()).slice(0, 55).replace(/\s+/g, ' ');
  console.log(`[${name}] ${r.status} (low12=0x${(BigInt('0x' + hexv) & 0xfffn).toString(16)}) :: ${txt}`);
}

await t('H0 control real        ', REAL.slice(4, 16));
await t('H1 000000000ffe        ', '000000000ffe');
await t('H2 123456780ffe        ', '123456780ffe');
await t('H3 ebcf32130ffd (low d)', 'ebcf32130ffd');
await t('H4 ebcf32130ff0 (low 0)', 'ebcf32130ff0');
await t('H5 ebcf32130fff (low f)', 'ebcf32130fff');
