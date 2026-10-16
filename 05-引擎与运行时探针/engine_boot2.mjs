// Boot an ISOLATED engine instance with fetch logging, to capture the exact outbound free-tier request.
import fs from 'node:fs';

const base = (import.meta.dirname + '/enginestate');
const port = Number(process.argv[2] || 19991);
const logFile = (import.meta.dirname + '/engine_http.jsonl');
for (const d of ['state', 'data', 'config', 'cache', 'home']) fs.mkdirSync(base + '\\' + d, { recursive: true });
fs.writeFileSync(logFile, '');

process.env.OPENCODE_CLIENT = 'desktop';
process.env.OPENCODE_SERVER_USERNAME = 'opencode';
process.env.OPENCODE_SERVER_PASSWORD = 'testpass';
process.env.XDG_STATE_HOME = base + '\\state';
process.env.XDG_DATA_HOME = base + '\\data';
process.env.XDG_CONFIG_HOME = base + '\\config';
process.env.XDG_CACHE_HOME = base + '\\cache';
delete process.env.OPENCODE_API_KEY;

// ---- capture every fetch the engine makes ----
const origFetch = globalThis.fetch;
const hdrsToObj = (h) => {
  try {
    if (!h) return {};
    if (typeof h.entries === 'function') return Object.fromEntries([...h.entries()]);
    if (Array.isArray(h)) return Object.fromEntries(h);
    return { ...h };
  } catch { return {}; }
};
globalThis.fetch = async (input, init) => {
  let rec = { t: Date.now(), kind: 'fetch' };
  try {
    const isReq = typeof input !== 'string' && input && typeof input === 'object' && 'url' in input;
    rec.url = isReq ? input.url : String(input);
    rec.method = (init && init.method) || (isReq && input.method) || 'GET';
    rec.headers = { ...hdrsToObj(isReq && input.headers), ...hdrsToObj(init && init.headers) };
    const body = (init && init.body) || (isReq && input.body);
    if (typeof body === 'string') rec.body = body;
    else if (body) rec.bodyType = String(body.constructor && body.constructor.name);
  } catch (e) { rec.err = String(e).slice(0, 200); }
  try { fs.appendFileSync(logFile, JSON.stringify(rec) + '\n'); } catch {}
  const res = await origFetch(input, init);
  try {
    fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), kind: 'response', url: rec.url, status: res.status }) + '\n');
  } catch {}
  return res;
};

console.log('BOOT_ENV', JSON.stringify({ node: process.version, cwd: process.cwd(), apikey: process.env.OPENCODE_API_KEY ?? null }));

try {
  const mod = await import((new URL('../99-解包产物与运行时残留/OpenCode-Desktop-1.19.2-解包/out/main/chunks/node-ibnNxpSl.js', import.meta.url).href));
  const listener = await mod.Server.listen({
    port, hostname: '127.0.0.1', username: 'opencode', password: 'testpass', cors: ['oc://renderer'],
  });
  console.log('LISTEN_OK', JSON.stringify(listener));
} catch (e) {
  console.log('BOOT_FAIL', String((e && e.stack) || e).slice(0, 1200));
}
setInterval(() => {}, 60000);
