// Bisect the low-12 boundary precisely.
import fs from 'node:fs';
const BODY = JSON.parse(fs.readFileSync(import.meta.dirname + '/captured_body.json', 'utf8'));
const URL = 'https://opencode.ai/inference/v1/chat/completions';
const mk = (low) => 'ses_ebcf3213' + low.toString(16).padStart(4, '0') + '7wJ1T06CSp2AP5';
const lows = process.argv.slice(2).map((s) => parseInt(s, 16));
for (const low of lows) {
  const sid = mk(low);
  const headers = { 'content-type': 'application/json', 'user-agent': 'opencode/1.19.2', 'x-opencode-session-id': sid, 'x-opencode-session': sid };
  let out;
  try {
    const r = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(BODY) });
    const t = await r.text();
    out = r.status + ' :: ' + t.slice(0, 70).replace(/\n/g, '');
  } catch (e) { out = 'ERR ' + String(e).slice(0, 100); }
  console.log('[0x' + low.toString(16) + ' = ' + low + '] ' + out);
}
