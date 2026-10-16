// Pin down the remaining two conditions: is it the system prompt (body) and/or an exact id format?
import fs from 'node:fs';
const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cap = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));
const H = cap.headers, FULL = cap.body;
const parsed = JSON.parse(FULL);
const sys = parsed.messages.find((m) => m.role === 'system').content;
console.log('system prompt len =', sys.length, '| head:', JSON.stringify(sys.slice(0, 60)));
console.log('real ses id =', H['x-opencode-session-id'], '(len', H['x-opencode-session-id'].length, ')');
console.log('real msg id =', H['x-opencode-request'], '(len', H['x-opencode-request'].length, ')');

const EXACT = { ...H, 'x-opencode-session-id': 'ses_aaaaaaaaaaaabbbbbbbbbbbbbb', 'x-opencode-session': 'ses_aaaaaaaaaaaabbbbbbbbbbbbbb', 'x-opencode-request': 'msg_aaaaaaaaaaaabbbbbbbbbbbbbb' };
const body1 = JSON.stringify({ model: parsed.model, max_tokens: 16, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Reply with exactly: PONG' }] });
const body2 = FULL.replace('You are opencode', 'You are NOT opencode');

async function t(name, headers, body) {
  try {
    const r = await fetch(cap.url, { method: 'POST', headers, body });
    const txt = (await r.text()).slice(0, 110).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); return -1; }
}

await t('Q0 V0 verbatim (control)', H, FULL);
await t('Q1 real headers + MINI body WITH opencode system prompt', H, body1);
await t('Q2 real headers + FULL body with "You are opencode" tampered', H, body2);
await t('Q3 exact-format SYNTHETIC ids + FULL body', EXACT, FULL);
await t('Q4 exact-format synthetic ids + MINI body + sys prompt', EXACT, body1);
