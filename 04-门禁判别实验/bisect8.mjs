// Narrow the recency window on the session-id timestamp.
import fs from 'node:fs';
const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));
const H = cap.headers, FULL = cap.body;
const REAL = H['x-opencode-session-id'];
const n = BigInt('0x' + REAL.slice(4, 16));
const TAIL = REAL.slice(16);
const hx = (v) => v.toString(16).padStart(12, '0').slice(-12);
const mk = (v) => { const s = 'ses_' + hx(v) + TAIL; return { ...H, 'x-opencode-session-id': s, 'x-opencode-session': s }; };

async function t(name, headers) {
  try {
    const r = await fetch(cap.url, { method: 'POST', headers, body: FULL });
    const txt = (await r.text()).slice(0, 55).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); return -1; }
}

const H1 = 3600000n;
for (const [label, ms] of [['+1h future', -H1], ['-1h', H1], ['-6h', 6n * H1], ['-12h', 12n * H1], ['-24h', 24n * H1], ['-48h', 48n * H1]]) {
  await t(`hex ${label} (${ms}ms)`, mk(n - ms * 4096n));
}
