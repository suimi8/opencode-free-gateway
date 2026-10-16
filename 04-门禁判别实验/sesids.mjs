// Inspect the id generator: create many sessions and look at the 12-hex block's low bits.
const PORT = process.argv[2] || '19991';
const AUTH = 'Basic ' + Buffer.from('opencode:testpass').toString('base64');
const B = 'http://127.0.0.1:' + PORT;
const H = { authorization: AUTH, 'content-type': 'application/json' };

const rows = [];
for (let i = 0; i < 24; i++) {
  const r = await fetch(B + '/session', { method: 'POST', headers: H, body: JSON.stringify({ title: 'idprobe' + i }) });
  const j = await r.json();
  const id = j.id;
  const hex = id.slice(4, 16);
  const v = BigInt('0x' + hex);
  rows.push({ id, hex, low12: '0x' + (v & 0xfffn).toString(16), low12dec: Number(v & 0xfffn), created: j.time?.created });
  await fetch(B + '/session/' + id, { method: 'DELETE', headers: H });
}
const lows = rows.map((r) => r.low12dec);
console.log('low12 values:', lows.join(','));
console.log('min', Math.min(...lows), 'max', Math.max(...lows));
console.log('all >= 0xfe0(4064)?', lows.every((v) => v >= 0xfe0));
console.log('all >= 0xf00(3840)?', lows.every((v) => v >= 0xf00));
console.log('\nfirst 6 rows:');
for (const r of rows.slice(0, 6)) console.log(' ', r.id, r.hex, r.low12, 'created', r.created);

// also a message id
const s = await (await fetch(B + '/session', { method: 'POST', headers: H, body: JSON.stringify({ title: 'msgprobe' }) })).json();
const m = await (await fetch(B + '/session/' + s.id + '/message', { method: 'POST', headers: H, body: JSON.stringify({ model: { providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' }, agent: 'build', noReply: true, parts: [{ type: 'text', text: 'x' }] }) })).json();
const mid = m?.info?.id ?? m?.id ?? JSON.stringify(m).slice(0, 200);
console.log('\nmessage id:', mid);
if (typeof mid === 'string' && mid.startsWith('msg_')) {
  const v = BigInt('0x' + mid.slice(4, 16));
  console.log('msg hex', mid.slice(4, 16), 'low12 0x' + (v & 0xfffn).toString(16));
}
await fetch(B + '/session/' + s.id, { method: 'DELETE', headers: H });
