// server.js — KX-Results server (zero-dependency skeleton).
//
// Built on node:http + node:sqlite so it runs with nothing but Node >= 22.5:
//     node server.js [dbfile] [port]
//
// LIVE UPDATES: this skeleton uses Server-Sent Events (GET /api/stream) as
// the change-notification channel — the "notify" half of the notify+fetch
// pattern. When you later run `npm install socket.io` on a networked
// machine, replace broadcast() with io.emit('change', topic); everything
// else (all fetching) stays exactly as it is. Gate Judge messaging will be
// added on the same channel in the next step.

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./lib/db');
const { api } = require('./lib/api');

const DB_FILE = process.argv[2] ?? path.join(__dirname, 'kx.db');
const PORT = +(process.argv[3] ?? 3000);
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript',
               '.css': 'text/css', '.svg': 'image/svg+xml' };

const db = open(DB_FILE);

// --- change notification (SSE) ---------------------------------------------
const sseClients = new Set();
function notify(topic) {
  for (const res of sseClients) res.write(`data: ${topic}\n\n`);
}
const routes = api(db, notify);

// --- http -------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // SSE stream: clients listen here and re-fetch on any message
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream',
                         'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // JSON API
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      let body = {};
      if (req.method !== 'GET') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      }
      const q = Object.fromEntries(url.searchParams);
      const result = handler(q, body) ?? {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static files (Phase page etc.)
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(path.join(PUBLIC, file));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'text/plain' });
  fs.createReadStream(file).pipe(res);
});

if (require.main === module) {
  server.listen(PORT, () =>
    console.log(`KX-Results server: http://localhost:${PORT}  (db: ${DB_FILE})`));
}

module.exports = { server, db };
