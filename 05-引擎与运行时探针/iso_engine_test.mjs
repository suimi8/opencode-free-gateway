// Probe the ISOLATED engine instance: does an anonymous free-tier call succeed there?
const BASE = 'http://127.0.0.1:19991';
const AUTH = 'Basic ' + Buffer.from('opencode:testpass').toString('base64');
const H = { Authorization: AUTH, 'Content-Type': 'application/json' };

const j = async (path, init = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const t = await r.text();
  return { status: r.status, body: t };
};

console.log('--- /provider (opencode entry) ---');
try {
  const p = await j('/provider');
  const parsed = JSON.parse(p.body);
  const oc = parsed.all?.find?.((x) => x.id === 'opencode');
  const free = oc?.models ? Object.values(oc.models).filter((m) => (m.cost?.input ?? 1) === 0).map((m) => m.id) : [];
  console.log('status', p.status, 'providers', parsed.all?.length, 'opencodeApiKey', JSON.stringify(oc?.options?.apiKey));
  console.log('freeModels', JSON.stringify(free.slice(0, 12)));
} catch (e) { console.log('provider ERR', String(e).slice(0, 300)); }

console.log('\n--- create session ---');
const s = await j('/session', { method: 'POST', body: JSON.stringify({ title: 'iso-free-probe' }) });
console.log('status', s.status, s.body.slice(0, 400));
let sid = null;
try { sid = JSON.parse(s.body).id; } catch {}
if (!sid) { console.log('no session id, aborting'); process.exit(0); }
console.log('session', sid);

console.log('\n--- POST message (deepseek-v4.1-flash-free) ---');
try {
  const r = await fetch(BASE + `/session/${sid}/message`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      model: { providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' },
      agent: 'build',
      parts: [{ type: 'text', text: 'Reply with exactly: PONG' }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const t = await r.text();
  console.log('status', r.status, 'len', t.length);
  console.log('body', t.slice(0, 1500));
} catch (e) { console.log('POST ERR', String(e).slice(0, 400)); }

console.log('\n--- read back messages ---');
const m = await j(`/session/${sid}/message`);
console.log('status', m.status, 'len', m.body.length);
try {
  const arr = JSON.parse(m.body);
  for (const msg of arr) {
    const info = msg.info ?? msg;
    const parts = (msg.parts ?? []).map((p) => `${p.type}:${(p.text ?? p.tool ?? '').toString().slice(0, 160)}`);
    console.log(`  role=${info.role} model=${info.modelID} in=${info.tokens?.input} out=${info.tokens?.output} cost=${info.cost} err=${JSON.stringify(info.error)?.slice(0, 300)}`);
    parts.slice(0, 3).forEach((p) => console.log('    ', p));
  }
} catch (e) { console.log('parse err', String(e).slice(0, 200), m.body.slice(0, 800)); }
