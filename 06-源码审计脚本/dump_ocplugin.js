const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
// locate OpencodePlugin definition
const idx = s.indexOf('async function OpencodePlugin');
console.log('OpencodePlugin at', idx);
const region = s.slice(idx, idx + 9000);
console.log(region.replace(/\r/g, ''));
