// test/event-order.test.js — event.sort_order and POST /api/events/reorder.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { open, migrate, uuid } = require('../lib/db');
const { api } = require('../lib/api');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');

function setup() {
  const db = open(':memory:');
  const routes = api(db, () => {});
  const compId = uuid();
  db.prepare(`INSERT INTO competition (competition_id, competition_name, start_date,
      end_date, country, gate_judge_pin) VALUES (?,?,?,?,?,?)`)
    .run(compId, 'Test Cup', '2026-06-01', '2026-06-02', 'FIN', '1234');
  return { db, routes, compId };
}

const codes = (routes, compId) =>
  routes['GET /api/events']({ competition_id: compId }).map(e => e.event_code);

const addEvent = (routes, compId, code) =>
  routes['POST /api/events']({}, {
    competition_id: compId, event_code: code, event_name: code, gates: 6,
  }).event_id;

test('new events are appended to the end of the running order', () => {
  const { routes, compId } = setup();
  // Deliberately NOT alphabetical: this is the whole point of the column.
  addEvent(routes, compId, 'WK1');
  addEvent(routes, compId, 'MK1');
  addEvent(routes, compId, 'MC1');
  assert.deepStrictEqual(codes(routes, compId), ['WK1', 'MK1', 'MC1']);
});

test('reorder renumbers the events 1..N and the list follows', () => {
  const { db, routes, compId } = setup();
  const wk1 = addEvent(routes, compId, 'WK1');
  const mk1 = addEvent(routes, compId, 'MK1');
  const mc1 = addEvent(routes, compId, 'MC1');

  routes['POST /api/events/reorder']({}, {
    competition_id: compId, event_ids: [mc1, wk1, mk1],
  });
  assert.deepStrictEqual(codes(routes, compId), ['MC1', 'WK1', 'MK1']);

  const orders = db.prepare(
    'SELECT event_code, sort_order FROM event WHERE competition_id = ? ORDER BY sort_order')
    .all(compId);
  assert.deepStrictEqual(orders.map(o => o.sort_order), [1, 2, 3]);
});

test('reorder is idempotent — applying the same order twice is a no-op', () => {
  const { routes, compId } = setup();
  const a = addEvent(routes, compId, 'AAA');
  const b = addEvent(routes, compId, 'BBB');
  routes['POST /api/events/reorder']({}, { competition_id: compId, event_ids: [b, a] });
  routes['POST /api/events/reorder']({}, { competition_id: compId, event_ids: [b, a] });
  assert.deepStrictEqual(codes(routes, compId), ['BBB', 'AAA']);
});

test('an event the client did not know about keeps its place, appended last', () => {
  const { routes, compId } = setup();
  const a = addEvent(routes, compId, 'AAA');
  const b = addEvent(routes, compId, 'BBB');
  addEvent(routes, compId, 'CCC');            // created "in another tab"
  // Stale client sends only the two events its page was rendered with.
  routes['POST /api/events/reorder']({}, { competition_id: compId, event_ids: [b, a] });
  assert.deepStrictEqual(codes(routes, compId), ['BBB', 'AAA', 'CCC']);
});

test('reorder rejects foreign, unknown and duplicated event ids', () => {
  const { db, routes, compId } = setup();
  const a = addEvent(routes, compId, 'AAA');

  const otherComp = uuid();
  db.prepare(`INSERT INTO competition (competition_id, competition_name, start_date,
      end_date, country, gate_judge_pin) VALUES (?,?,?,?,?,?)`)
    .run(otherComp, 'Other', '2026-07-01', '2026-07-02', 'SWE', '1111');
  const foreign = addEvent(routes, otherComp, 'ZZZ');

  assert.throws(() => routes['POST /api/events/reorder'](
    {}, { competition_id: compId, event_ids: [a, foreign] }), /does not belong/);
  assert.throws(() => routes['POST /api/events/reorder'](
    {}, { competition_id: compId, event_ids: [a, a] }), /listed twice/);
  assert.throws(() => routes['POST /api/events/reorder'](
    {}, { competition_id: compId, event_ids: 'nope' }), /must be an array/);
  // The other competition is untouched by a failed call.
  assert.deepStrictEqual(codes(routes, otherComp), ['ZZZ']);
});

test('sort_order is editable directly via PATCH', () => {
  const { routes, compId } = setup();
  addEvent(routes, compId, 'AAA');
  const b = addEvent(routes, compId, 'BBB');
  routes['PATCH /api/events']({}, { event_id: b, sort_order: 0 });
  assert.deepStrictEqual(codes(routes, compId), ['BBB', 'AAA']);
});

test('events that all share a sort_order still list alphabetically', () => {
  const { db, routes, compId } = setup();
  // Exactly the state of a database that has never been reordered.
  addEvent(routes, compId, 'WK1');
  addEvent(routes, compId, 'MK1');
  db.exec('UPDATE event SET sort_order = 0');
  assert.deepStrictEqual(codes(routes, compId), ['MK1', 'WK1']);
});

test('migrate() adds sort_order to a pre-existing database and backfills it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kx-')), 'old.db');

  // Build a database with the OLD event table (no sort_order column).
  const old = new DatabaseSync(file);
  old.exec('PRAGMA foreign_keys = ON;');
  old.exec(SCHEMA.replace(/^\s*sort_order\s+INTEGER NOT NULL DEFAULT 0,.*?(?=^\s*current_phase)/ms, ''));
  const compId = uuid();
  old.prepare(`INSERT INTO competition (competition_id, competition_name, start_date,
      end_date, country, gate_judge_pin) VALUES (?,?,?,?,?,?)`)
    .run(compId, 'Legacy Cup', '2025-06-01', '2025-06-02', 'FIN', '1234');
  for (const code of ['WK1', 'MK1', 'MC1']) {
    old.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name, gates)
                 VALUES (?,?,?,?,6)`).run(uuid(), compId, code, code);
  }
  assert.ok(!old.prepare('PRAGMA table_info(event)').all().map(c => c.name).includes('sort_order'));
  old.close();

  // Opening it with the current code must upgrade it in place.
  const db = open(file);
  const cols = db.prepare('PRAGMA table_info(event)').all().map(c => c.name);
  assert.ok(cols.includes('sort_order'));

  // Backfilled 1..N in event_code order — the order these events were
  // already displayed in, so upgrading changes nothing visible.
  const rows = db.prepare(
    'SELECT event_code, sort_order FROM event ORDER BY sort_order').all(),
    routes = api(db, () => {});
  assert.deepStrictEqual(rows.map(r => r.event_code), ['MC1', 'MK1', 'WK1']);
  assert.deepStrictEqual(rows.map(r => r.sort_order), [1, 2, 3]);
  assert.deepStrictEqual(codes(routes, compId), ['MC1', 'MK1', 'WK1']);

  // ...and running the migration again is harmless.
  migrate(db);
  assert.deepStrictEqual(codes(routes, compId), ['MC1', 'MK1', 'WK1']);
  db.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
