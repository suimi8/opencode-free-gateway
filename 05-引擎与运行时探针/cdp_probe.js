// Chromium (BoringSSL) transport-fingerprint probe for the OpenCode free-tier gate.
// If the 403 FreeTierError is transport-fingerprint based, a real Chromium client should not get it.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const EXE = process.argv[2];
const PORT = 9333;
const PROFILE = path.join(os.tmpdir(), 'oc_cdp_prof_' + Date.now());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(pathname, init) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, init);
  return r.json();
}

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(EXE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { ver = await json('/json/version'); break; } catch { await sleep(500); }
  }
  if (!ver) { console.log('FAILED to start chromium CDP'); child.kill(); process.exit(1); }
  console.log('browser: ' + ver.Browser + '  ua=' + ver['User-Agent']);

  const target = await json(`/json/new?${encodeURIComponent('https://opencode.ai/')}`, { method: 'PUT' });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  await send('Page.enable');
  await sleep(3500); // let https://opencode.ai/ load so fetch is same-origin

  const expr = `(async () => {
    const out = [];
    const hdrs = { 'Content-Type': 'application/json', 'Authorization': 'Bearer public',
                   'x-opencode-client': 'desktop' };
    try {
      const r = await fetch('https://opencode.ai/inference/v1/chat/completions', {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ model: 'cat-jam-free', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 16 })
      });
      out.push('STATUS=' + r.status);
      out.push('BODY=' + (await r.text()).slice(0, 400));
    } catch (e) { out.push('ERR=' + e.message); }
    try {
      const r2 = await fetch('https://opencode.ai/inference/v1/models', { headers: { 'Authorization': 'Bearer public' } });
      out.push('MODELS_STATUS=' + r2.status + ' len=' + (await r2.text()).length);
    } catch (e) { out.push('MODELS_ERR=' + e.message); }
    return out.join(' | ');
  })()`;

  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log('RESULT: ' + JSON.stringify(res.result && res.result.result ? res.result.result.value : res));

  ws.close();
  child.kill();
  await sleep(500);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
})();
