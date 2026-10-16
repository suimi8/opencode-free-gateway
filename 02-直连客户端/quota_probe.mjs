// 1) 再采样 retry-after，确认是否指向 UTC 零点
// 2) 换其他免费模型，看额度桶是否按模型分开
import fs from 'node:fs';
import https from 'node:https';

const BODY = JSON.parse(fs.readFileSync((import.meta.dirname + '/body_template.json'), 'utf8'));
const HEX = '0123456789abcdef';
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const r = (n) => Math.floor(Math.random() * n);
const sid = () => 'ses_' + Array.from({ length: 9 }, () => HEX[r(16)]).join('') + (0xfc0 + r(0x40)).toString(16) + Array.from({ length: 14 }, () => B62[r(62)]).join('');

function call(model) {
  const b = { ...BODY, model, max_tokens: 16, messages: [BODY.messages[0], { role: 'user', content: 'Reply with exactly one word: PONG' }], stream: true, stream_options: { include_usage: true } };
  const body = JSON.stringify(b);
  const s = sid();
  return new Promise((resolve) => {
    const req = https.request({
      host: 'opencode.ai', port: 443, path: '/inference/v1/chat/completions', method: 'POST',
      headers: {
        authorization: 'Bearer public', 'content-type': 'application/json',
        'user-agent': 'opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24',
        'x-opencode-client': 'desktop', 'x-opencode-project': 'global',
        'x-opencode-request': 'msg_' + Array.from({ length: 12 }, () => HEX[r(16)]).join('') + Array.from({ length: 14 }, () => B62[r(62)]).join(''),
        'x-opencode-session': s, 'x-opencode-session-id': s,
      },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let txt = '';
        for (const line of out.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try { const j = JSON.parse(line.slice(5)); const d = j.choices?.[0]?.delta?.content; if (d) txt += d; } catch {}
        }
        resolve({ status: res.statusCode, retryAfter: res.headers['retry-after'] || null, text: txt.slice(0, 40) });
      });
    });
    req.on('error', (e) => resolve({ status: 0, err: e.message }));
    req.setTimeout(60000, () => req.destroy());
    req.end(body);
  });
}

const now = new Date();
console.log('now(UTC) =', now.toISOString());
for (const m of ['longcat-2.5-preview-free', 'cat-jam-free', 'space-bunny-free', 'mimo-v2.6-flash-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'nemotron-3.5-super-vl-free', 'deepseek-v4.1-flash-free', 'big-pickle', 'muse-spark-1.3-contributor-free']) {
  const r2 = await call(m);
  let reset = '';
  if (r2.retryAfter) reset = ' reset=' + new Date(now.getTime() + Number(r2.retryAfter) * 1000).toISOString();
  console.log(`  ${m.padEnd(28)} → ${r2.status}${r2.retryAfter ? ' retry-after=' + r2.retryAfter + reset : ''}${r2.text ? ' text=' + JSON.stringify(r2.text) : ''}${r2.err ? ' ' + r2.err : ''}`);
}
