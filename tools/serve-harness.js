// Minimal static server for tools/.harness (the mocked-backend copy of the app).
// Usage: node tools/serve-harness.js  -> http://localhost:8765/
const http = require('http');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '.harness');
http.createServer((req, res) => {
  const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
  if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream', 'Last-Modified': fs.statSync(p).mtime.toUTCString() });
  res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(p));
}).listen(8765, () => console.log('Harness at http://localhost:8765/'));
