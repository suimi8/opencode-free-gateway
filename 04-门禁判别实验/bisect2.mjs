// Resolve the 2x2: are the x-opencode-* VALUES real-checked, or is the BODY the gate?
import fs from 'node:fs';
const U = 'https://opencode.ai/inference/v1/chat/completions';
const CT = { 'content-type': 'application/json', authorization: 'Bearer public' };
const MINI = JSON.stringify({ model: 'deepseek-v4.1-flash-free', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] });

const lines = fs.readFileSync((import.meta.dirname + '/../07-原始证据/engine_http.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));
const FULL = cap.body;
const REAL = Object.fromEntries(Object.entries(cap.headers).filter(([k]) => k.toLowerCase().startsWith('x-opencode')));
const FAKE = {
  'x-opencode-session-id': 'ses_00000000000000000000000000000000000000',
  'x-opencode-session': 'ses_00000000000000000000000000000000000000',
  'x-opencode-request': 'msg_00000000000000000000000000000000000000',
  'x-opencode-project': 'global', 'x-opencode-client': 'desktop',
};
console.log('REAL x-opencode headers =', JSON.stringify(REAL));

async function t(name, hdrs, body) {
  try {
    const r = await fetch(U, { method: 'POST', headers: { ...CT, ...hdrs }, body });
    const txt = (await r.text()).slice(0, 130).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); return -1; }
}

await t('Y1 FULL body + FAKE x-opencode', FAKE, FULL);
await t('Y2 FULL body + NO x-opencode (control)', {}, FULL);
await t('Y3 MINI body + REAL x-opencode', REAL, MINI);
await t('Y4 MINI body + REAL session-id only', { 'x-opencode-session-id': REAL['x-opencode-session-id'] }, MINI);
await t('Y5 FULL body + REAL session-id only', { 'x-opencode-session-id': REAL['x-opencode-session-id'] }, FULL);
