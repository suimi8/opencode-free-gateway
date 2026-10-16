// Boot an ISOLATED engine instance (own port, own XDG dirs) to observe free-tier behaviour.
const fs = require('node:fs');
const base = (require('node:path').join(__dirname, 'enginestate'));
const port = Number(process.argv[2] || 19991);
for (const d of ['state', 'data', 'config', 'cache', 'home']) fs.mkdirSync(base + '\\' + d, { recursive: true });

process.env.OPENCODE_CLIENT = 'desktop';
process.env.OPENCODE_SERVER_USERNAME = 'opencode';
process.env.OPENCODE_SERVER_PASSWORD = 'testpass';
process.env.XDG_STATE_HOME = base + '\\state';
process.env.XDG_DATA_HOME = base + '\\data';
process.env.XDG_CONFIG_HOME = base + '\\config';
process.env.XDG_CACHE_HOME = base + '\\cache';
delete process.env.OPENCODE_API_KEY;

console.log('BOOT_ENV', JSON.stringify({
  client: process.env.OPENCODE_CLIENT,
  state: process.env.XDG_STATE_HOME,
  data: process.env.XDG_DATA_HOME,
  config: process.env.XDG_CONFIG_HOME,
  apikey: process.env.OPENCODE_API_KEY ?? null,
  node: process.version,
  cwd: process.cwd(),
}));

try {
  const mod = await import((require('node:url').pathToFileURL(require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js')).href));
  console.log('MODULE_KEYS', JSON.stringify(Object.keys(mod).slice(0, 40)));
  const listener = await mod.Server.listen({
    port,
    hostname: '127.0.0.1',
    username: 'opencode',
    password: 'testpass',
    cors: ['oc://renderer'],
  });
  console.log('LISTEN_OK', JSON.stringify(listener));
} catch (e) {
  console.log('BOOT_FAIL', String(e && e.stack || e).slice(0, 1500));
}
