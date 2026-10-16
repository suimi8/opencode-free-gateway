// One-variable-at-a-time bisection from the reproducibly-200 V0.
import fs from 'node:fs';
const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));
const H = cap.headers, FULL = cap.body;
const MINI = JSON.stringify({ model: 'deepseek-v4.1-flash-free', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] });
const FAKE = { ...H, 'x-opencode-session-id': 'ses_00000000000000000000000000000000000000', 'x-opencode-session': 'ses_00000000000000000000000000000000000000', 'x-opencode-request': 'msg_00000000000000000000000000000000000000', 'x-opencode-project': 'global' };
const NOUA = Object.fromEntries(Object.entries(H).filter(([k]) => k.toLowerCase() !== 'user-agent'));
const NOAUTH = Object.fromEntries(Object.entries(H).filter(([k]) => k.toLowerCase() !== 'authorization'));

async function t(name, headers, body) {
  try {
    const r = await fetch(cap.url, { method: 'POST', headers, body });
    const txt = (await r.text()).slice(0, 110).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); return -1; }
}

await t('P0 V0 verbatim (control)', H, FULL);
await t('P1 V0 minus user-agent', NOUA, FULL);
await t('P2 V0 headers + MINI body', H, MINI);
await t('P3 V0 headers + FAKE x-opencode values + FULL body', FAKE, FULL);
await t('P4 V0 minus authorization', NOAUTH, FULL);
await t('P5 V0 headers + MINI body + max_tokens 32000 + stream', H, JSON.stringify({ model: 'deepseek-v4.1-flash-free', max_tokens: 32000, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] }));
