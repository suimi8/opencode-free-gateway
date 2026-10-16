// Pin the exact low-12 threshold: 0xfd0, 0xfdf, 0xfe0, 0xfe1
import fs from 'node:fs';
const BODY = JSON.parse(fs.readFileSync(import.meta.dirname + '/captured_body.json', 'utf8'));
const UA = 'opencode/1.19.2';
const URL = 'https://opencode.ai/inference/v1/chat/completions';
const mk = (low) => 'ses_' + 'ebcf3213' + low.toString(16).padStart(4, '0') + '7wJ1T06CSp2AP5';

for (const low of [0xfd0, 0xfdf, 0xfe0, 0xfe1]) {
  const sid = mk(low);
  const headers = {
    'content-type': 'application/json',
    'user-agent': UA,
    'x-opencode-session-id': sid,
    'x-opencode-session': sid,
  };
  let out;
  try {
    const r = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(BODY) });
    const t = await r.text();
    out = r.status + ' :: ' + t.slice(0, 90);
  } catch (e) { out = 'ERR ' + String(e).slice(0, 120); }
  console.log('[low12=0x' + low.toString(16) + '] ' + out);
}
