// 诊断：429 到底带什么头？直连 vs 代理 是否同一限制？
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';

const HOST = 'opencode.ai';
const BODY = fs.readFileSync((import.meta.dirname + '/body_template.json'), 'utf8');
const HEX = '0123456789abcdef';
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const r = (n) => Math.floor(Math.random() * n);
const sid = () => 'ses_' + Array.from({ length: 9 }, () => HEX[r(16)]).join('') + (0xfc0 + r(0x40)).toString(16) + Array.from({ length: 14 }, () => B62[r(62)]).join('');

const headers = () => ({
  authorization: 'Bearer public',
  'content-type': 'application/json',
  'user-agent': 'opencode/1.19.2 ai-sdk/provider-utils/4.0.23 runtime/node.js/24',
  'x-opencode-client': 'desktop',
  'x-opencode-project': 'global',
  'x-opencode-request': 'msg_' + Array.from({ length: 12 }, () => HEX[r(16)]).join('') + Array.from({ length: 14 }, () => B62[r(62)]).join(''),
  'x-opencode-session': sid(),
  'x-opencode-session-id': sid(),
});

function show(label, status, hdrs, body) {
  console.log(`\n===== ${label} → HTTP ${status} =====`);
  console.log(JSON.stringify(hdrs, null, 2));
  console.log('body:', body.slice(0, 300));
}

// ---------- 直连 ----------
await new Promise((resolve) => {
  const req = https.request(
    { host: HOST, port: 443, path: '/inference/v1/chat/completions', method: 'POST', headers: headers() },
    (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => { show('直连', res.statusCode, res.headers, b); resolve(); });
    },
  );
  req.on('error', (e) => { console.log('直连 error', e.message); resolve(); });
  req.setTimeout(60000, () => req.destroy());
  req.end(BODY);
});

// ---------- 走 Clash 代理（CONNECT 隧道）----------
await new Promise((resolve) => {
  const c = http.request({ host: '127.0.0.1', port: 7897, method: 'CONNECT', path: `${HOST}:443`, timeout: 15000 });
  c.once('connect', (cres, socket) => {
    if (cres.statusCode !== 200) { console.log('代理 CONNECT 失败', cres.statusCode); return resolve(); }
    const t = tls.connect({ socket, servername: HOST, ALPNProtocols: ['http/1.1'] });
    t.once('secureConnect', () => {
      const req = https.request(
        { host: HOST, port: 443, path: '/inference/v1/chat/completions', method: 'POST', headers: headers(), createConnection: () => t },
        (res) => {
          let b = '';
          res.setEncoding('utf8');
          res.on('data', (x) => (b += x));
          res.on('end', () => { show('代理 127.0.0.1:7897', res.statusCode, res.headers, b); resolve(); });
        },
      );
      req.on('error', (e) => { console.log('代理 error', e.message); resolve(); });
      req.setTimeout(60000, () => req.destroy());
      req.end(BODY);
    });
    t.once('error', (e) => { console.log('TLS error', e.message); resolve(); });
  });
  c.on('error', (e) => { console.log('CONNECT error', e.message); resolve(); });
  c.on('timeout', () => { c.destroy(); console.log('CONNECT timeout'); resolve(); });
  c.end();
});
