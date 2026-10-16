// Binary-search the exact threshold T on the session-id 12-hex prefix.
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

async function t(v) {
  const r = await fetch(cap.url, { method: 'POST', headers: mk(v), body: FULL });
  await r.text();
  return r.status;
}

let lo = BigInt('0xeb0000000000'); // known 403
let hi = n;                        // known 200
console.log('real n =', n.toString(), hx(n), '| now =', Date.now());
for (let i = 0; i < 9; i++) {
  const mid = (lo + hi) / 2n;
  const st = await t(mid);
  console.log(`probe ${i}: ${hx(mid)} (${mid}) => ${st}`);
  if (st === 200) hi = mid; else lo = mid;
  if (hi - lo < 4096n) break;
}
console.log('THRESHOLD bracket: lo(403)=', lo.toString(), hx(lo), ' hi(200)=', hi.toString(), hx(hi));
console.log('delta from real in ms =', ((n - hi) / 4096n).toString(), 'ms =', Number((n - hi) / 4096n) / 3600000, 'hours');
