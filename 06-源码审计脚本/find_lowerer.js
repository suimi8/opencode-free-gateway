const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
const pats = [
  /@ai-sdk\/openai-compatible/g,
  /createOpenAICompatible/g,
  /openaiCompatible/g,
];
for (const p of pats) {
  const hits = [...s.matchAll(p)];
  console.log(`\n### ${p} -> ${hits.length} : ${hits.slice(0,12).map(h=>h.index).join(', ')}`);
}
// find the lowerer registry
const i = s.indexOf('function get18(');
console.log('\n=== get18 at', i, '===');
console.log(s.slice(i, i + 2500).replace(/\r/g, ''));
