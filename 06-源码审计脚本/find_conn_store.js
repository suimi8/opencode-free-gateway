const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
for (const p of [/Info5\s*=\s*class Info5[\s\S]{0,700}/g, /active:\s*(?:fn2?\(|\(id)[\s\S]{0,500}/g, /IntegrationTable|integration_connection|ConnectionTable/g]) {
  const hits = [...s.matchAll(p)];
  console.log(`\n### ${p} -> ${hits.length}`);
  hits.slice(0, 4).forEach(h => console.log(`@${h.index} ${h[0].slice(0, 900).replace(/\s+/g, ' ')}`));
}
console.log('\n\n================ Integration service impl ================');
const i = s.indexOf('IntegrationHttpApi');
console.log('IntegrationHttpApi at', i);
const j = s.search(/fn2\("Integration\./);
console.log('fn2("Integration. at', j);
const k = s.indexOf('integrationID: ID4');
console.log('integrationID: ID4 at', k);
// find the service that implements connection.active
const m = [...s.matchAll(/active\(id12?\)[\s\S]{0,300}/g)];
console.log('\nactive(id) impls:', m.length);
m.slice(0, 6).forEach(h => console.log(`@${h.index} ${h[0].replace(/\s+/g, ' ')}`));
