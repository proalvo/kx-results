// electron/server-child.js — the KX-Results server, run as a child of the
// desktop launcher.
//
// This file is deliberately thin. It is not a second server: it requires the
// same server.js the command line uses and calls start() on it, so there is
// one HTTP implementation, one route table and one database layer no matter
// how the software was started. Everything it adds is process plumbing —
// telling the launcher whether the port could be opened, and shutting down
// cleanly when the launcher asks.

'use strict';

const { start, stop } = require('../server');

const port = Number(process.env.KX_PORT) || 3000;
const host = process.env.KX_HOST || '0.0.0.0';

start({ port, host })
  .then(info => {
    console.log(`KX-Results listening on ${host}:${info.port} (db: ${info.db_file})`);
    process.send?.({ type: 'ready', port: info.port, host, db_file: info.db_file });
  })
  .catch(err => {
    // The launcher turns this into a sentence the operator can act on. Sending
    // the errno code as well as the message is what lets it distinguish "that
    // port is taken" from "that folder is not writable".
    process.send?.({ type: 'error', message: err.message, code: err.code });
    process.exit(1);
  });

process.on('message', msg => {
  if (msg?.type === 'shutdown') {
    stop().then(() => process.exit(0));
  }
});

// A parent that died without asking is still a parent that is gone: there is
// no launcher left to stop this server, so it should not outlive it.
process.on('disconnect', () => { stop().then(() => process.exit(0)); });

// Uncaught exceptions in request handlers should not leave the serial port
// held open by an orphaned timing bridge.
process.on('uncaughtException', err => {
  console.error(err);
  stop().then(() => process.exit(1));
});
