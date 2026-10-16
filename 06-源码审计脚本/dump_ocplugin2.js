const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
const anchors = ['make("opencode")', 'id: "opencode"', '"opencode":', 'Opencode'];
for (const a of anchors) {
  const hits = [...s.matchAll(new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  console.log(`\n### ${a} -> ${hits.length}  positions: ${hits.slice(0,10).map(h=>h.index).join(', ')}`);
}
// print backwards signature for the plugin at 22981277
const target = 22981277;
console.log('\n=== context before 22981277 (3000 chars) ===');
console.log(s.slice(target - 3000, target + 1500).replace(/\r/g, ''));
