const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
const pats = [
  /"chat\.headers"/g,
  /chat\.headers/g,
  /\.opencode[\\\/]plugin/g,
  /plugin\.list|Plugin2\.list|loadPlugin|pluginDir|PLUGIN_DIR/g,
  /"chat\.params"|chat\.params/g,
];
for (const p of pats) {
  const hits = [...s.matchAll(p)];
  console.log(`\n### ${p} -> ${hits.length}`);
  hits.slice(0, 6).forEach(h => console.log(`@${h.index}  ...${s.slice(Math.max(0, h.index - 260), h.index + 260).replace(/\s+/g, ' ')}...`));
}
