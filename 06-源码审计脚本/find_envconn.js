const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
console.log('================ region 2063000..2066000 (Integration service) ================');
console.log(s.slice(2063000, 2066000));
console.log('\n\n================ resolveConnections + env connections ================');
for (const p of [/resolveConnections\s*=?\s*\(?[\s\S]{0,600}/g, /type:\s*"env"[\s\S]{0,200}/g, /OPENCODE_API_KEY[\s\S]{0,160}/g]) {
  const hits = [...s.matchAll(p)];
  console.log(`\n### ${p} -> ${hits.length}`);
  hits.slice(0, 8).forEach(h => console.log(`@${h.index} ${h[0].replace(/\s+/g, ' ').slice(0, 500)}`));
}
