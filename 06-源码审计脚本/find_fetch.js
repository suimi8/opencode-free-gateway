const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
const pats = [
  /websocketFetchInstalled/g,
  /globalThis\.fetch\s*=/g,
  /globalThis\.fetch/g,
  /TITLE_HEADER/g,
  /installWebSocketFetch|WebSocketFetch|wsFetch|installFetch/g,
  /fetch\s*=\s*createWebSocket/g,
];
for (const p of pats) {
  const hits = [...s.matchAll(p)];
  console.log(`\n### ${p} -> ${hits.length}`);
  hits.slice(0, 5).forEach(h => console.log(`@${h.index}  ...${s.slice(Math.max(0, h.index - 400), h.index + 500).replace(/\s+/g, ' ')}...`));
}
