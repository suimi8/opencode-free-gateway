// Find the threshold T on the 12-hex session-id prefix.
import fs from 'node:fs';
const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));
const H = cap.headers, FULL = cap.body;
const TAIL = H['x-opencode-session-id'].slice(16);
const mk = (hexv) => { const s = 'ses_' + hexv + TAIL; return { ...H, 'x-opencode-session-id': s, 'x-opencode-session': s }; };

async function t(name, headers) {
  try {
    const r = await fetch(cap.url, { method: 'POST', headers, body: FULL });
    const txt = (await r.text()).slice(0, 60).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); return -1; }
}

for (const h of ['800000000000', 'c00000000000', 'e00000000000', 'ea0000000000', 'eb0000000000']) {
  const v = BigInt('0x' + h);
  const approxMs = Number(v / 4096n) + 1728826686880;
  await t(`hex ${h} (val ${v}) ~${new Date(approxMs).toISOString()}`, mk(h));
}
