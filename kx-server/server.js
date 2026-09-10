
// server.js — KX-Results server with 24" Leaderboard (zero-dependency skeleton).
//
// Built on node:http + node:sqlite so it runs with nothing but Node >= 22.5:
//     node server.js [dbfile] [port]
//
// The desktop build (electron/main.js) does not use the command line: it forks
// electron/server-child.js, which requires this file and calls start(). The
// database file, port and bind address therefore also come from KX_DB_FILE,
// KX_PORT and KX_HOST, so the same server.js serves both the terminal and the
// packaged app with no branch anywhere in the request path.

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./lib/db');
const { api } = require('./lib/api');
const { attachWebPublisher } = require('./lib/publisher-wire');
const { attachStarttiin } = require('./lib/starttiin');
const leaderboardAPI = require('./lib/leaderboard-api');
// Alge Timing's Timy
const { attachTimy } = require('./lib/timy-wire');

//
// argv wins over the environment: someone typing `node server.js other.db 4000`
// at the scoring desk means it, even inside the desktop app's shell.
const DB_FILE = process.argv[2] ?? process.env.KX_DB_FILE ?? path.join(__dirname, 'kx.db');
const PORT = +(process.argv[3] ?? process.env.KX_PORT ?? 3000);
// Default to every interface, which is what the Gate Judge phones need. The
// desktop launcher narrows this to 127.0.0.1 when the operator picks the
// localhost address, so a laptop on a public wifi is not serving the
// competition to the whole network unless that was asked for.
const HOST = process.env.KX_HOST ?? '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript',
               '.css': 'text/css', '.svg': 'image/svg+xml' };

const db = open(DB_FILE);

// --- change notification (SSE) ---------------------------------------------
const sseClients = new Set();
// `detail` is optional extra context for the KX-Web publisher (currently
// { deletedEventId, deletedEventCode } from DELETE /api/events). The SSE
// message stays a bare topic string, so browser pages are unaffected.
function notify(topic, detail) {
  for (const res of sseClients) res.write(`data: ${topic}\n\n`);
  web.onNotify(topic, detail);               // KX-Web publisher (no-op until registered)
}
const routes = api(db, notify);
const leaderRoutes = leaderboardAPI(db);     // Add leaderboard routes
Object.assign(routes, leaderRoutes);         // Merge leaderboard routes into main routes
const web = attachWebPublisher(db, routes);  // adds /api/web/* routes
attachStarttiin(db, routes, notify);         // adds /api/starttiin/* routes

const timy = attachTimy(db, routes, notify); // adds /api/timy/* routes; no-op
                                             // when timy-bridge/ is absent

// --- http -------------------------------------------------------------------
// Match a request against the routes registered with ':param' segments.
// Only reached when no exact-pathname route exists, so the common case
// stays a single hash lookup. Segment counts must agree and every literal
// segment must match; ':name' captures one segment.
function matchParamRoute(table, method, pathname) {
  const want = pathname.split('/');
  for (const key of Object.keys(table)) {
    const [m, pattern] = key.split(' ');
    if (m !== method || !pattern.includes('/:')) continue;
    const parts = pattern.split('/');
    if (parts.length !== want.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) {
        if (!want[i]) { ok = false; break; }
        params[parts[i].slice(1)] = decodeURIComponent(want[i]);
      } else if (parts[i] !== want[i]) { ok = false; break; }
    }
    if (ok) return { handler: table[key], params };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Special handling for leaderboard HTML (GET /leaderboard)
  if (req.method === 'GET' && url.pathname === '/leaderboard') {
    const handler = routes['GET /leaderboard'];
    if (handler) {
      try {
        const result = await handler({});
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(result.html);
        return;
      } catch (e) {
        res.writeHead(500);
        res.end('Error: ' + e.message);
        return;
      }
    }
  }

  // SSE stream: clients listen here and re-fetch on any message
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream',
                         'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // JSON API (including leaderboard endpoints)
  // Exact pathname first; failing that, try the routes registered with
  // path parameters (e.g. 'POST /api/competition/:id/pdf-header'). Without
  // this second step those routes are unreachable: they were only ever
  // looked up by literal string, so ':id' never matched a real uuid and
  // setup.html's logo upload answered 404. Matched segments are merged
  // into the query object, so a handler still just reads q.id.
  let handler = routes[`${req.method} ${url.pathname}`];
  let pathParams = {};
  if (!handler) {
    const m = matchParamRoute(routes, req.method, url.pathname);
    if (m) { handler = m.handler; pathParams = m.params; }
  }
  if (handler) {
    try {
      let body = {};
      if (req.method !== 'GET') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      }
      const q = { ...pathParams, ...Object.fromEntries(url.searchParams) };
      const result = (await handler(q, body)) ?? {};   // handlers may be async (/api/web/*)
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

// --- lifecycle --------------------------------------------------------------
// start()/stop() exist so the process that owns the server is not required to
// be the process that was started from a command line. The desktop launcher
// needs the listen error (EADDRINUSE, EACCES) as a rejected promise it can put
// in front of the operator — "Port 3000 is already in use" is a fixable
// problem, and a stack trace on a hidden stdout is not.
function start({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const onError = err => { server.off('listening', onListening); reject(err); };
    const onListening = () => {
      server.off('error', onError);
      resolve({ port: server.address().port, host, db_file: DB_FILE });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// Close in the order things were opened: the timing bridge first (it is a
// child process holding a serial port), then the SSE streams, which would
// otherwise keep the HTTP server open forever — every leaderboard and Gate
// Judge page is a connection that never ends by itself.
function stop() {
  return new Promise(resolve => {
    try { timy.stop(); } catch { /* bridge already gone */ }
    for (const res of sseClients) { try { res.end(); } catch { /* client gone */ } }
    sseClients.clear();
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

if (require.main === module) {
  start().then(() =>
    console.log(`\n\n KX-Results server: http://localhost:${PORT}  (db: ${DB_FILE})`
              + `\n Leaderboard: http://localhost:${PORT}/leaderboard`
              + `\n Press Ctrl + C to stop the software\n\n`))
    .catch(err => { console.error(`\n Could not start: ${err.message}\n`); process.exit(1); });
  process.on('SIGINT', () => { stop().then(() => process.exit(0)); });
}

module.exports = { server, db, start, stop, DB_FILE, PORT, HOST };
