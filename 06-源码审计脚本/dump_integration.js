const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
console.log('================ Integration service region (1915000..1919500) ================');
console.log(s.slice(1915000, 1919500));
console.log('\n\n================ search: connection storage ================');
for (const p of [/active:\s*(?:fn2?\(|\(id)/g, /connection\.active\(ID/g, /Connection[A-Za-z]*\s*=\s*Struct/g, /credential\.list|credential\.get|credential\.create/g]) {
  const hits = [...s.matchAll(p)];
  console.log(`\n### ${p} -> ${hits.length}`);
  hits.slice(0, 10).forEach(h => console.log(`@${h.index} ...${s.slice(Math.max(0, h.index - 300), h.index + 400).replace(/\s+/g, ' ')}...`));
}
