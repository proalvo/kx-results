// lib/db.js — database access for KX-Results.
//
// Uses Node's built-in sqlite module (Node >= 22.5). Its API intentionally
// mirrors better-sqlite3, so if you later prefer that package:
//     npm install better-sqlite3
//     const Database = require('better-sqlite3');
//     const db = new Database(file);
// ...and everything else in this codebase keeps working unchanged.

'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_FILE = path.join(__dirname, '..', 'schema.sql');

// Lazy schema upgrades for kx.db files created by an earlier version.
// Same approach publisher-wire.js already uses for server_setting: the
// server repairs the schema on open, so upgrading is "replace the code and
// restart", with no separate migration step for the Chief of Scoring to run
// (and nothing to forget on the morning of a competition).
// Each block must be safe to run on an already-migrated database.
function migrate(db) {
  const eventCols = db.prepare('PRAGMA table_info(event)').all().map(c => c.name);

  // event.sort_order — organiser-defined running order of the events.
  if (!eventCols.includes('sort_order')) {
    db.exec('ALTER TABLE event ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    // Backfill 1..N per competition in event_code order — the order these
    // events were already being listed in before this column existed. The
    // visible order therefore does not change on upgrade; it just becomes
    // editable. (Left at the DEFAULT 0 instead, every event would tie and
    // sort_order would look broken the first time someone tried to use it.)
    const rows = db.prepare(
      'SELECT event_id, competition_id FROM event ORDER BY competition_id, event_code').all();
    const set = db.prepare('UPDATE event SET sort_order = ? WHERE event_id = ?');
    let lastComp = null, n = 0;
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        if (r.competition_id !== lastComp) { lastComp = r.competition_id; n = 0; }
        set.run(++n, r.event_id);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  const compCols = db.prepare('PRAGMA table_info(competition)').all().map(c => c.name);

  // competition.tt_continuous_clock — split-time TT timing with one clock
  // running across all events, so the time shift applies to the first event
  // only (see lib/tt-timing.js). Defaulting to 0 means an upgraded database
  // keeps behaving exactly as it did — the clock restarts per event — and
  // every TT time already derived from a split reading stays correct.
  if (!compCols.includes('tt_continuous_clock')) {
    db.exec('ALTER TABLE competition ADD COLUMN tt_continuous_clock INTEGER NOT NULL DEFAULT 0');
  }
}

function open(file = path.join(__dirname, '..', 'kx.db')) {
  const isNew = file === ':memory:' || !fs.existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (isNew) {
    db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  } else {
    migrate(db);
  }
  return db;
}

const uuid = () => randomUUID();

module.exports = { open, migrate, uuid };


