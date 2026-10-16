// Find how the engine computes the `connected` list returned by GET /provider
const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
const pats = [
  /connected:\s*[^,\n}]{0,120}/g,
  /const\s+connected\s*=\s*[^;]{0,200}/g,
  /connected\s*=\s*(?:await\s*)?[A-Za-z0-9_.$()\[\]]{1,80}/g,
];
for (const p of pats) {
  const hits = [...s.matchAll(p)];
  console.log(`\n### ${p}  -> ${hits.length} hits`);
  hits.slice(0, 25).forEach(h => {
    const i = h.index;
    console.log(`@${i}  ...${s.slice(Math.max(0, i - 260), i + 300).replace(/\s+/g, ' ')}...`);
  });
}
