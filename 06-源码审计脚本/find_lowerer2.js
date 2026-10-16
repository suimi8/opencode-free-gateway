const fs = require('fs');
const f = require('node:path').join(__dirname, '..', '99-解包产物与运行时残留', 'OpenCode-Desktop-1.19.2-解包', 'out', 'main', 'chunks', 'node-ibnNxpSl.js');
const s = fs.readFileSync(f, 'utf8');
const i = s.indexOf('lowerers = {');
console.log('lowerers at', i);
console.log(s.slice(i - 3400, i + 1200).replace(/\r/g, ''));
