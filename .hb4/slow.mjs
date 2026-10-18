import http from 'node:http';
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => {
      res.write('data: {"id":"e","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"}}]}' + '\n\n');
      res.write('data: [DONE]' + '\n\n');
      res.end();
    }, 2000);
  });
});
srv.listen(18795, '127.0.0.1', () => console.log('READY'));
