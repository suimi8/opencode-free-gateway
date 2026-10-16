// UA / header-shape variants, including the long channel UA form.
const U = 'https://opencode.ai/inference/v1/chat/completions';
const sid = crypto.randomUUID(), uid = crypto.randomUUID();
const body = (model) => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 16,
});
const base = {
  'x-opencode-session-id': sid,
  'x-opencode-session': sid,
  'x-opencode-request': uid,
  'x-opencode-project': uid,
};
async function t(name, headers) {
  try {
    const r = await fetch(U, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body('deepseek-v4.1-flash-free')) });
    console.log(`[${name}] ${r.status} :: ${(await r.text()).slice(0, 180).replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`[${name}] ERR ${e.message}`); }
}
(async () => {
  await t('ua-long-desktop', { ...base, Authorization: 'Bearer public', 'x-opencode-client': 'desktop', 'User-Agent': 'opencode/prod/1.19.2/desktop' });
  await t('ua-long-cli', { ...base, Authorization: 'Bearer public', 'x-opencode-client': 'cli', 'User-Agent': 'opencode/prod/1.19.2/cli' });
  await t('ua-short-only-no-client', { ...base, Authorization: 'Bearer public', 'User-Agent': 'opencode/1.19.2' });
  await t('ua-chromium-like', { ...base, Authorization: 'Bearer public', 'x-opencode-client': 'desktop', 'User-Agent': 'Mozilla/5.0 opencode/1.19.2' });
  await t('no-ua-no-auth-full-oc-hdrs', { ...base, 'x-opencode-client': 'desktop' });
  await t('authorization-only-public-ua', { Authorization: 'Bearer public', 'User-Agent': 'opencode/1.19.2' });
  await t('model-space-bunny-free', { ...base, Authorization: 'Bearer public', 'x-opencode-client': 'desktop', 'User-Agent': 'opencode/1.19.2' });
})();
