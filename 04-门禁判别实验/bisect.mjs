// Bisect the free-tier gate: which x-opencode-* header, and does the value format matter?
const U = 'https://opencode.ai/inference/v1/chat/completions';
const MINI = JSON.stringify({
  model: 'deepseek-v4.1-flash-free',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
});
const CT = { 'content-type': 'application/json', authorization: 'Bearer public' };

// engine-shaped (well-formed) but entirely synthetic values
const SES = 'ses_00000000000000000000000000000000000000';
const MSG = 'msg_00000000000000000000000000000000000000';

async function t(name, hdrs) {
  try {
    const r = await fetch(U, { method: 'POST', headers: { ...CT, ...hdrs }, body: MINI });
    const txt = (await r.text()).slice(0, 150).replace(/\s+/g, ' ');
    console.log(`[${name}] ${r.status} :: ${txt}`);
    return r.status;
  } catch (e) {
    console.log(`[${name}] ERR ${e.message}`);
    return -1;
  }
}

await t('X1 all5 well-formed fake', {
  'x-opencode-session-id': SES, 'x-opencode-session': SES, 'x-opencode-request': MSG,
  'x-opencode-project': 'global', 'x-opencode-client': 'desktop',
});
await t('X2 only session-id(ses_)', { 'x-opencode-session-id': SES });
await t('X3 only session(ses_)', { 'x-opencode-session': SES });
await t('X4 only request(msg_)', { 'x-opencode-request': MSG });
await t('X5 only project=global', { 'x-opencode-project': 'global' });
await t('X6 only client=desktop', { 'x-opencode-client': 'desktop' });
await t('X7 all5 but UUID values (old sweep)', {
  'x-opencode-session-id': crypto.randomUUID(), 'x-opencode-session': crypto.randomUUID(),
  'x-opencode-request': crypto.randomUUID(), 'x-opencode-project': crypto.randomUUID(),
  'x-opencode-client': 'desktop',
});
