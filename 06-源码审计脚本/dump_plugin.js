const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
const A = 22981000, B = 22984200;
console.log('================ OpencodePlugin region ================');
console.log(s.slice(A, B));
console.log('\n\n================ where connections are stored ================');
for (const p of [/connection\.active\s*\(/g, /IntegrationConnection/g, /integrations?\.json/g, /integration\.connection/g]) {
  const hits = [...s.matchAll(p)];
  console.log(`\n### ${p} -> ${hits.length}`);
  hits.slice(0, 12).forEach(h => console.log(`@${h.index} ...${s.slice(Math.max(0, h.index - 200), h.index + 260).replace(/\s+/g, ' ')}...`));
}
