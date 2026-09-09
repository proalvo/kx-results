// lib/timy-wire.js — optional ALGE Timy3 timing, wired into kx-server.
//
// Follows the same shape as attachWebPublisher/attachStarttiin: it is handed
// the db, the route table and notify(), and it adds /api/timy/* routes.
//
// The bridge is OPTIONAL. At startup we look for timy-bridge/index.js:
//
//   * not there  -> GET /api/timy/status answers { available: false } and the
//                   Phase page simply doesn't render the timing panel. Nobody
//                   installs a serial library they don't need, and kx-server
//                   keeps its zero-dependency install.
//   * there      -> we fork it as a child process and talk over IPC. A crash
//                   in the native serial layer kills the child, not the
//                   results server; we restart it with backoff.
//
// Impulses are never written straight into `result`. They land in
// timing_impulse with status PENDING, the Chief of Scoring sees them in the
// queue with a proposed athlete, and only POST /api/timy/impulses/:id/confirm
// writes a time. That is what makes a false light-gate trigger a visible
// flagged line rather than a wrong result.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { uuid } = require('./db');

const BRIDGE_DIR = path.join(__dirname, '..', 'timy-bridge');
const BRIDGE_ENTRY = path.join(BRIDGE_DIR, 'index.js');
const REQUEST_TIMEOUT_MS = 10000;
const RESTART_MS = [1000, 2000, 5000, 15000, 30000];

// --------------------------------------------------------------- schema
// Lazy upgrade, same pattern as server_setting in publisher-wire.js: the
// table appears on first run of a version that has this feature, with no
// migration step for the Chief of Scoring to remember.
function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS timing_impulse (
    impulse_id   TEXT PRIMARY KEY,
    received_at  TEXT NOT NULL,
    seq          INTEGER,                       -- order within the bridge session
    raw          TEXT NOT NULL,                 -- the exact ALGE line, for audit
    info         TEXT,                          -- info flag (' ', 'i', 'm', ...)
    bib          TEXT,                          -- start number as sent by the Timy
    channel      TEXT,                          -- c0, c1, c1M, RT, ...
    kind         TEXT,                          -- RUN_TIME | START | FINISH | OTHER
    time_text    TEXT,                          -- HH:MM:SS.zhtq as received
    run_time_ms  INTEGER,                       -- validated Time Trial time, or NULL
    accepted     INTEGER NOT NULL DEFAULT 0,    -- passed bridge validation
    reject_code  TEXT,
    reject_reason TEXT,
    status       TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','CONFIRMED','IGNORED')),
    competition_id TEXT,
    result_id    TEXT,                          -- set when confirmed
    confirmed_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_timing_impulse_status
           ON timing_impulse(status, received_at)`);
}

// -------------------------------------------------------------- process
function createBridge(db, notify) {
  let child = null;
  let restarts = 0;
  let stopped = false;
  let lastStatus = { connected: false, port: null };
  const pending = new Map();          // request id -> { resolve, reject, timer }

  function start() {
    if (stopped) return;
    child = fork(BRIDGE_ENTRY, [], { cwd: BRIDGE_DIR, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

    child.on('message', msg => {
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        if (msg.ok) {
          // Command replies carry a full status too (connect, disconnect,
          // configure all return status()). Fold it into the cache, so a
          // stale snapshot cannot outlive the command that corrected it.
          if ('connected' in msg) {
            const { id, ok, ...rest } = msg;
            lastStatus = rest;
          }
          resolve(msg);
        } else {
          reject(Object.assign(new Error(msg.error), { code: msg.code, port: msg.port }));
        }
        return;
      }
      if (msg.event === 'impulse') { onImpulse(msg.impulse); return; }
      if (msg.event === 'status') {
        // Drop the envelope's own `event` key: this object is served verbatim
        // by GET /api/timy/status, and an internal message type leaking into
        // the API response is confusing to anyone reading it.
        const { event, ...rest } = msg;
        lastStatus = rest;
        notify('timing');
        return;
      }
      if (msg.event === 'log') { console.log(`[timy:${msg.level}] ${msg.message}`); }
    });

    child.on('exit', code => {
      child = null;
      lastStatus = { connected: false, port: null, error: `bridge exited (${code})` };
      notify('timing');
      if (stopped) return;
      const delay = RESTART_MS[Math.min(restarts++, RESTART_MS.length - 1)];
      console.log(`[timy] bridge exited (${code}) — restarting in ${delay} ms`);
      setTimeout(start, delay).unref?.();
    });

    child.stderr?.on('data', d => console.error(`[timy] ${d}`.trimEnd()));
    restarts = 0;
  }

  function request(cmd, extra = {}) {
    if (!child) return Promise.reject(new Error('Timy bridge is not running.'));
    const id = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timy bridge did not answer "${cmd}" within ${REQUEST_TIMEOUT_MS} ms.`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, cmd, ...extra });
    });
  }

  // Store every impulse — accepted or rejected. A rejected impulse is still
  // shown to the operator (status PENDING, accepted 0) because the validator
  // can be wrong and a discarded time cannot be recovered.
  function onImpulse(i) {
    db.prepare(`INSERT INTO timing_impulse
      (impulse_id, received_at, seq, raw, info, bib, channel, kind, time_text,
       run_time_ms, accepted, reject_code, reject_reason, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING')`)
      .run(uuid(), i.received_at, i.seq ?? null, i.raw, i.info ?? null, i.bib ?? null,
           i.channel ?? null, i.kind ?? null, i.time_text ?? null,
           i.run_time_ms ?? null, i.accepted ? 1 : 0,
           i.reject_code ?? null, i.reject_reason ?? null);
    notify('timing');
  }

  // Ask before killing: on Windows child.kill() is an unconditional terminate,
  // so the child never gets to close the serial port itself. Give it a moment
  // to answer, then insist.
  function stop() {
    stopped = true;
    if (!child) return;
    const doomed = child;
    request('shutdown').catch(() => {});
    setTimeout(() => { if (!doomed.killed) doomed.kill(); }, 500).unref?.();
  }

  return { start, stop, request, get status() { return lastStatus; }, get running() { return !!child; } };
}

// --------------------------------------------------------------- match
// Propose the athlete a pending impulse belongs to. Bib first — if the timing
// operator keys start numbers into the Timy, the match is exact rather than
// inferred. Otherwise fall back to the next TT slot without a time, in the
// organiser's event running order (event.sort_order, then event_code), which
// is the order the Time Trials are actually paddled in.
function proposeAthlete(db, competitionId, impulse) {
  if (impulse.bib) {
    const byBib = db.prepare(
      `SELECT r.result_id, r.event_id, r.slot_no, r.time_ms,
              ea.bib, ea.first_name, ea.last_name, e.event_code, e.event_name
         FROM result r
         JOIN event e ON e.event_id = r.event_id
         JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
        WHERE e.competition_id = ? AND r.phase = 'TT' AND ea.bib = ?
        ORDER BY e.sort_order, e.event_code`).all(competitionId, impulse.bib);
    if (byBib.length === 1) return { ...byBib[0], matched_by: 'bib' };
    if (byBib.length > 1) {
      const open = byBib.filter(r => r.time_ms == null);
      if (open.length === 1) return { ...open[0], matched_by: 'bib' };
      return null;                        // same bib in several events — ask
    }
  }

  const next = db.prepare(
    `SELECT r.result_id, r.event_id, r.slot_no, r.time_ms,
            ea.bib, ea.first_name, ea.last_name, e.event_code, e.event_name
       FROM result r
       JOIN event e ON e.event_id = r.event_id
       JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
      WHERE e.competition_id = ? AND r.phase = 'TT'
        AND r.time_ms IS NULL AND r.status IS NULL
      ORDER BY e.sort_order, e.event_code, r.slot_no
      LIMIT 1`).get(competitionId);
  return next ? { ...next, matched_by: 'slot' } : null;
}

// -------------------------------------------------------------- routes
function attachTimy(db, routes, notify) {
  const available = fs.existsSync(BRIDGE_ENTRY);

  if (!available) {
    routes['GET /api/timy/status'] = () => ({
      available: false,
      reason: 'timy-bridge is not installed — Time Trial times are entered by hand.',
    });
    return { available: false, stop() {} };
  }

  ensureSchema(db);
  const bridge = createBridge(db, notify);
  bridge.start();

  // Ask the child rather than answering from the cache. Readiness is the one
  // question that must never be answered from a stale snapshot: the cache is
  // empty for the first moment after startup (so the page would render as if
  // installed), and it outlives a child that has died (so it would keep
  // claiming the dependency is present). One IPC round trip is cheap.
  routes['GET /api/timy/status'] = async () => {
    if (!bridge.running) {
      return {
        available: true, running: false, connected: false, port: null,
        serialport_available: null,
        reason: 'The Timy bridge process is not running. It is restarted ' +
                'automatically; if this persists, check the server log.',
      };
    }
    try {
      const live = await bridge.request('status');
      const { id, ok, ...rest } = live;
      return { available: true, running: true, ...rest };
    } catch (e) {
      // The child is up but not answering — starting, or wedged.
      return {
        available: true, running: true, connected: false, port: null,
        serialport_available: null, reason: `Timy bridge did not answer: ${e.message}`,
      };
    }
  };

  routes['GET /api/timy/ports'] = () => bridge.request('list-ports');

  // Scan and connect in one step: used on page load, so the common case
  // (one Timy plugged in) needs no interaction at all.
  routes['POST /api/timy/auto-connect'] = () => bridge.request('auto-connect');

  // `force` is the "connect anyway" path for an unrecognised device — a
  // simulator, or a Timy3 behind a plain RS232-to-USB adapter.
  routes['POST /api/timy/connect'] = (q, body) => bridge.request('connect', {
    path: body.path, baud: body.baud, force: !!body.force,
  });

  routes['POST /api/timy/disconnect'] = () => bridge.request('disconnect');

  routes['POST /api/timy/configure'] = (q, body) => bridge.request('configure', {
    mode: body.mode, validation: body.validation,
  });

  // The operator's queue: pending impulses, newest last, each with the
  // athlete the server thinks it belongs to.
  routes['GET /api/timy/impulses'] = q => {
    const rows = db.prepare(
      `SELECT * FROM timing_impulse WHERE status = ?
        ORDER BY received_at LIMIT 100`).all(q.status ?? 'PENDING');
    return {
      impulses: rows.map(r => ({
        ...r,
        accepted: !!r.accepted,
        proposed: q.competition_id ? proposeAthlete(db, q.competition_id, r) : null,
      })),
    };
  };

  // Every TT slot of the competition in running order — what the Reassign
  // dropdown offers. Includes slots that already have a time, so a correction
  // (the operator confirmed the wrong athlete a minute ago) is possible
  // without leaving the panel.
  routes['GET /api/timy/candidates'] = q => ({
    candidates: db.prepare(
      `SELECT r.result_id, r.slot_no, r.time_ms, r.status,
              ea.bib, ea.first_name, ea.last_name,
              e.event_id, e.event_code, e.event_name, e.sort_order
         FROM result r
         JOIN event e ON e.event_id = r.event_id
         JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
        WHERE e.competition_id = ? AND r.phase = 'TT'
        ORDER BY e.sort_order, e.event_code, r.slot_no`).all(q.competition_id),
  });

  // Confirm: the only path that writes a time. `result_id` comes from the UI
  // so a reassignment (operator picked a different slot) is honoured over the
  // server's proposal.
  routes['POST /api/timy/impulses/:impulse_id/confirm'] = (q, body) => {
    const imp = db.prepare('SELECT * FROM timing_impulse WHERE impulse_id = ?').get(q.impulse_id);
    if (!imp) throw new Error('No such impulse.');
    if (imp.status !== 'PENDING') throw new Error(`Impulse already ${imp.status.toLowerCase()}.`);
    if (imp.run_time_ms == null) {
      throw new Error('This impulse carries no usable time — it was rejected by validation.');
    }
    // A time the bridge rejected can still be used, but only deliberately:
    // the UI has to say `override`, and the operator has seen the reason.
    if (!imp.accepted && !body.override) {
      throw new Error(`This impulse was rejected: ${imp.reject_reason}. ` +
        'Use it anyway only if you are sure it is the athlete\u2019s real time.');
    }
    const resultId = body.result_id;
    if (!resultId) throw new Error('No athlete selected for this time.');

    db.exec('BEGIN');
    try {
      // The Timy sends the actual Time Trial time, so it goes into time_ms
      // directly — split_time_ms stays untouched, and split-time timing
      // (lib/tt-timing.js) is simply not in use when timing electronically.
      db.prepare(
        `UPDATE result SET time_ms = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE result_id = ? AND phase = 'TT'`).run(imp.run_time_ms, resultId);
      db.prepare(
        `UPDATE timing_impulse
            SET status = 'CONFIRMED', result_id = ?, competition_id = ?,
                confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE impulse_id = ?`).run(resultId, body.competition_id ?? null, q.impulse_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    notify('results');
    notify('timing');
    return { ok: true, result_id: resultId, time_ms: imp.run_time_ms };
  };

  // Ignore: a false trigger the operator has judged. The row stays in the
  // table — an ignored impulse is evidence, not rubbish.
  routes['POST /api/timy/impulses/:impulse_id/ignore'] = q => {
    db.prepare(`UPDATE timing_impulse SET status = 'IGNORED' WHERE impulse_id = ?`)
      .run(q.impulse_id);
    notify('timing');
    return { ok: true };
  };

  return { available: true, stop: () => bridge.stop(), proposeAthlete };
}

module.exports = { attachTimy, ensureSchema, proposeAthlete, BRIDGE_DIR, BRIDGE_ENTRY };
