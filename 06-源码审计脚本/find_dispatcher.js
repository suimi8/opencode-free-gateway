const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
const pats = [
  /setGlobalDispatcher[\s\S]{0,200}/g,
  /new Agent\(\{[\s\S]{0,300}/g,
  /new ProxyAgent\([\s\S]{0,160}/g,
  /require\("undici"\)|from "undici"|node:http2|require\("http2"\)/g,
  /interceptors\.\w+\(/g,
  /connect:\s*\{[\s\S]{0,200}/g,
];
for (const p of pats) {
  const hits = [...s.matchAll(p)];
  console.log(`\n### ${p} -> ${hits.length}`);
  hits.slice(0, 8).forEach(h => console.log(`@${h.index} ${h[0].replace(/\s+/g, ' ').slice(0, 400)}`));
}
