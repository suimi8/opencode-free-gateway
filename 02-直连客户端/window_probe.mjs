// 判定额度窗口语义：retry-after 是「固定重置点」还是「滚动窗口」？
// 固定点 → 每次采样的 (now + retry-after) 相同；滚动窗口 → 该值随时间推移而前移。
import fs from 'node:fs';
import https from 'node:https';

const BODY = JSON.parse(fs.readFileSync((import.meta.dirname + '/body_template.json'), 'utf8'));
const HEX = '0123456789abcdef';
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const r = (n) => Math.floor(Math.random() * n);
const sid = () => 'ses_' + Array.from({ length: 9 }, () => HEX[r(16)]).join('') + (0xfc0 + r(0x40)).toString(16) + Array.from({ length: 14 }, () => B62[r(62)]).join('');

function call(model) {
  const b = { ...BODY, model, max_tokens: 8, messages: [BODY.messages[0], { role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } };
  const s = sid();
  return new Promise((resolve) => {
    const req = https.request({
      host: 'opencode.ai', port: 443, path: '/inference/v1/chat/completions', method: 'POST',
      headers: { authorization: 'Bearer public', 'content-type': 'application/json', 'user-agent': 'opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24', 'x-opencode-client': 'desktop', 'x-opencode-project': 'global', 'x-opencode-request': 'msg_' + Array.from({ length: 12 }, () => HEX[r(16)]).join('') + Array.from({ length: 14 }, () => B62[r(62)]).join(''), 'x-opencode-session': s, 'x-opencode-session-id': s },
    }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, ra: res.headers['retry-after'] })); });
    req.on('error', (e) => resolve({ status: 0, err: e.message }));
    req.setTimeout(30000, () => req.destroy());
    req.end(JSON.stringify(b));
  });
}

const M = 'deepseek-v4.1-flash-free';
for (let i = 0; i < 4; i++) {
  const t = Date.now();
  const r2 = await call(M);
  const ra = Number(r2.ra);
  console.log(`t=${new Date(t).toISOString()} status=${r2.status} retry-after=${r2.ra} → 目标重置点=${Number.isFinite(ra) ? new Date(t + ra * 1000).toISOString() : 'n/a'}`);
  if (i < 3) await new Promise((res) => setTimeout(res, 30000));
}
