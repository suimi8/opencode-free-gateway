// Replay the captured engine request verbatim, then bisect the discriminator.
import fs from 'node:fs';

const LF = (import.meta.dirname + '/../07-原始证据/engine_http.jsonl');
const lines = fs.readFileSync(LF, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const req = lines.find((r) => r.kind === 'fetch' && !r.url.includes('127.0.0.1'));

console.log('=== CAPTURED REQUEST ===');
console.log('url     :', req.url);
console.log('method  :', req.method);
console.log('headers :', JSON.stringify(req.headers, null, 1));
console.log('body len:', req.body.length);
console.log('body head:', req.body.slice(0, 160));
console.log('body tail:', req.body.slice(-320));
console.log('');

const H = req.headers;
const B = req.body;
const noX = Object.fromEntries(Object.entries(H).filter(([k]) => !k.toLowerCase().startsWith('x-opencode')));
const MINI = JSON.stringify({
  model: 'deepseek-v4.1-flash-free',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
});

async function attempt(label, headers, body) {
  try {
    const r = await fetch(req.url, { method: 'POST', headers, body });
    const t = await r.text();
    console.log(`--- ${label}\n    status=${r.status} body=${t.slice(0, 200)}`);
    return r.status;
  } catch (e) {
    console.log(`--- ${label}\n    THREW ${String(e).slice(0, 200)}`);
    return -1;
  }
}

const results = {};
results['V0_verbatim_full_body'] = await attempt('V0 verbatim (all captured headers + captured body)', H, B);
results['V1_ua_short'] = await attempt('V1 same headers, UA shortened to "opencode/1.19.2"', { ...H, 'user-agent': 'opencode/1.19.2' }, B);
results['V2_no_xopencode'] = await attempt('V2 captured UA, x-opencode-* removed', noX, B);
results['V3_ua_full_mini'] = await attempt('V3 captured UA only + minimal body', { authorization: 'Bearer public', 'content-type': 'application/json', 'user-agent': H['user-agent'] }, MINI);
results['V4_ua_short_mini'] = await attempt('V4 UA "opencode/1.19.2" + minimal body', { authorization: 'Bearer public', 'content-type': 'application/json', 'user-agent': 'opencode/1.19.2' }, MINI);
results['V5_no_auth_full_ua'] = await attempt('V5 no authorization, captured UA + minimal body', { 'content-type': 'application/json', 'user-agent': H['user-agent'] }, MINI);

console.log('\n=== SUMMARY ===');
for (const [k, v] of Object.entries(results)) console.log(k, '=>', v);
