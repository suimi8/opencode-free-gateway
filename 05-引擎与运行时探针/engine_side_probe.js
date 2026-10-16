// Probe run FROM INSIDE the OpenCode engine's own shell (child of the sidecar process).
// Purpose: is the free-tier gate about the process/network path, or about the in-process HTTP stack?
const out = (o) => console.log('RESULT ' + JSON.stringify(o));

(async () => {
  out({ where: 'engine-shell-child', node: process.version, cwd: process.cwd() });
  const proxyVars = {};
  for (const k of Object.keys(process.env)) if (/proxy/i.test(k)) proxyVars[k] = process.env[k];
  out({ proxyVars });

  // 1) egress IP as seen by this process (IPv4 and IPv6)
  for (const url of ['https://api.ipify.org', 'https://api64.ipify.org']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      out({ egress: url, status: r.status, ip: (await r.text()).trim() });
    } catch (e) { out({ egress: url, error: String(e && e.message || e) }); }
  }

  // 2) the replica inference request, engine-shaped
  const model = process.argv[2] || 'deepseek-v4.1-flash-free';
  const body = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 16,
  };
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'opencode/1.19.2',
    'x-opencode-client': 'desktop',
    'x-opencode-session-id': 'ses_engine_side_probe',
    'x-opencode-project': 'global',
    'x-opencode-request': 'msg_engine_side_probe',
    'x-opencode-session': 'ses_engine_side_probe',
    authorization: 'Bearer public',
  };
  try {
    const r = await fetch('https://opencode.ai/inference/v1/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    const t = await r.text();
    out({ inference: model, status: r.status, headers: Object.fromEntries(r.headers), body: t.slice(0, 500) });
  } catch (e) { out({ inference: model, error: String(e && e.message || e) }); }

  // 3) models list
  try {
    const r = await fetch('https://opencode.ai/inference/v1/models', { headers: { authorization: 'Bearer public', 'user-agent': 'opencode/1.19.2' }, signal: AbortSignal.timeout(20000) });
    out({ models: r.status, len: (await r.text()).length });
  } catch (e) { out({ models: 'error', error: String(e && e.message || e) }); }
})();
