// Run under Electron's own Node runtime (ELECTRON_RUN_AS_NODE=1) to test whether
// the client's transport/runtime is what satisfies the free-tier gate.
const U = 'https://opencode.ai/inference/v1/chat/completions';
const sid = crypto.randomUUID();
const uid = crypto.randomUUID();

const body = {
  model: process.argv[2] || 'deepseek-v4.1-flash-free',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 16,
};

const headers = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer public',
  'User-Agent': 'opencode/1.19.2',
  'x-opencode-session-id': sid,
  'x-opencode-session': sid,
  'x-opencode-request': uid,
  'x-opencode-project': uid,
  'x-opencode-client': 'desktop',
};

(async () => {
  console.log('runtime: ' + process.version + '  electron=' + (process.versions.electron || 'n/a') +
              '  openssl=' + (process.versions.openssl || 'n/a') + '  boringssl=' + (process.versions.boringssl || 'n/a'));
  try {
    const r = await fetch(U, { method: 'POST', headers, body: JSON.stringify(body) });
    const t = (await r.text()).slice(0, 400).replace(/\s+/g, ' ');
    console.log('STATUS=' + r.status + ' :: ' + t);
  } catch (e) {
    console.log('ERROR ' + e.message + ' | cause=' + (e.cause ? String(e.cause).slice(0, 200) : '-'));
  }
})();
