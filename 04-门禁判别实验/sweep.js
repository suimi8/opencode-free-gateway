// Broad variant sweep against the free-tier endpoint.
const U = 'https://opencode.ai/inference/v1/chat/completions';
const sid = crypto.randomUUID(), uid = crypto.randomUUID();

const ocHdrs = {
  'x-opencode-session-id': sid,
  'x-opencode-session': sid,
  'x-opencode-request': uid,
  'x-opencode-project': uid,
  'x-opencode-client': 'desktop',
  'User-Agent': 'opencode/1.19.2',
};

const body = (model, extra) => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 16,
  ...extra,
});

async function t(name, url, headers, b, method = 'POST') {
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: b ? JSON.stringify(b) : undefined,
    });
    const txt = (await r.text()).slice(0, 220).replace(/\s+/g, ' ');
    const extra = ['x-opencode-log-id', 'server', 'cf-ray', 'allow'].map((h) => r.headers.get(h) ? `${h}=${r.headers.get(h)}` : null).filter(Boolean).join(' ');
    console.log(`[${name}] ${r.status} ${extra} :: ${txt}`);
  } catch (e) {
    console.log(`[${name}] ERR ${e.message}`);
  }
}

(async () => {
  const M = 'deepseek-v4.1-flash-free';
  await t('01 baseline full replica', U, { ...ocHdrs, Authorization: 'Bearer public', Accept: 'text/event-stream' }, body(M));
  await t('02 provider-prefixed model', U, { ...ocHdrs, Authorization: 'Bearer public' }, body('opencode/' + M));
  await t('03 bogus model', U, { ...ocHdrs, Authorization: 'Bearer public' }, body('definitely-not-a-real-model-xyz'));
  await t('04 no auth, bogus model', U, { ...ocHdrs }, body('definitely-not-a-real-model-xyz'));
  await t('05 client=app', U, { ...ocHdrs, 'x-opencode-client': 'app', Authorization: 'Bearer public' }, body(M));
  await t('06 client=cli', U, { ...ocHdrs, 'x-opencode-client': 'cli', Authorization: 'Bearer public' }, body(M));
  await t('07 client empty', U, { ...ocHdrs, 'x-opencode-client': '', Authorization: 'Bearer public' }, body(M));
  await t('08 Origin set', U, { ...ocHdrs, Authorization: 'Bearer public', Origin: 'https://opencode.ai' }, body(M));
  await t('09 Referer set', U, { ...ocHdrs, Authorization: 'Bearer public', Referer: 'https://opencode.ai/' }, body(M));
  await t('10 responses endpoint', 'https://opencode.ai/inference/v1/responses', { ...ocHdrs, Authorization: 'Bearer public' }, { model: M, input: 'hi' });
  await t('11 models via POST', U.replace('/chat/completions', '/models'), { Authorization: 'Bearer public' }, null, 'GET');
  await t('12 OPTIONS', U, { ...ocHdrs, Authorization: 'Bearer public', 'Access-Control-Request-Method': 'POST' }, null, 'OPTIONS');
  await t('13 chat/completions GET', U, { ...ocHdrs, Authorization: 'Bearer public' }, null, 'GET');
  await t('14 key-like auth', U, { ...ocHdrs, Authorization: 'Bearer sk-public' }, body(M));
  await t('15 bare public no Bearer', U, { ...ocHdrs, Authorization: 'public' }, body(M));
})();
