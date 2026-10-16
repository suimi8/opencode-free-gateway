// Test the OFFICIALLY DOCUMENTED free-tier path found by external-docs.
const paths = [
  'https://opencode.ai/inference/openai/v1/chat/completions',
  'https://opencode.ai/inference/v1/chat/completions',
  'https://opencode.ai/inference/openai/v1/models',
  'https://opencode.ai/inference/v1/models',
];
const body = JSON.stringify({
  model: 'deepseek-v4.1-flash-free',
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 32,
});
const headers = {
  'Content-Type': 'application/json',
  'User-Agent': 'opencode/prod/1.19.2/desktop',
  'x-opencode-session-id': crypto.randomUUID(),
  'x-opencode-client': 'desktop',
};
(async () => {
  for (const p of paths) {
    const isChat = p.includes('chat/completions');
    try {
      const r = await fetch(p, { method: isChat ? 'POST' : 'GET', headers, body: isChat ? body : undefined });
      const txt = await r.text();
      console.log(`[${isChat ? 'POST' : 'GET '}] ${r.status}  ${p}`);
      console.log(`        ${txt.slice(0, 320).replace(/\s+/g, ' ')}`);
    } catch (e) { console.log(`[ERR] ${p} :: ${e.message}`); }
  }
})();
