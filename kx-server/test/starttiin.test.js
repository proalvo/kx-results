'use strict';

// test/starttiin.test.js — starttiin.fi import against the REAL kx-server
// schema in an in-memory node:sqlite database, network mocked.
// Run: node --test  (or node test/starttiin.test.js)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { open, uuid } = require('../lib/db');
const {
  parseFullName, normalizeStartLists, buildPreview, saveStartLists,
  fetchStartLists, attachStarttiin,
} = require('../lib/starttiin');

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'starttiin-startlist.json'), 'utf8'));

function seed(db, { events = ['KXM', 'KXW'] } = {}) {
  const compId = uuid();
  db.prepare(`INSERT INTO competition (competition_id, competition_name, start_date,
              end_date, country, gate_judge_pin)
              VALUES (?, 'SM Koskicross 2026', '2026-08-01', '2026-08-02', 'FIN', '1234')`)
    .run(compId);
  const eventIds = {};
  for (const code of events) {
    const id = uuid();
    db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name, gates)
                VALUES (?, ?, ?, ?, 4)`).run(id, compId, code, 'Kayak Cross ' + code);
    eventIds[code] = id;
  }
  return { compId, eventIds };
}

// ------------------------------------------------------------- name parsing
test('parseFullName: last space separates first and last name', () => {
  assert.deepStrictEqual(parseFullName('Mette Maarit Mäkinen'),
    { first_name: 'Mette Maarit', last_name: 'Mäkinen' });
  assert.deepStrictEqual(parseFullName('Matti Meikäläinen'),
    { first_name: 'Matti', last_name: 'Meikäläinen' });
  assert.deepStrictEqual(parseFullName('  Aino   Maija   Virtanen '),
    { first_name: 'Aino Maija', last_name: 'Virtanen' });
  assert.deepStrictEqual(parseFullName('Cher'),
    { first_name: '', last_name: 'Cher' });
});

// -------------------------------------------------------------- normalizing
test('normalizeStartLists: maps spec fields, tolerates participants shapes, sorts by startOrder', () => {
  const lists = normalizeStartLists(FIXTURE);
  assert.strictEqual(lists.length, 2);
  assert.strictEqual(lists[0].event_code, 'KXM');
  assert.deepStrictEqual(lists[0].competitors[2], {
    start_order: 3, bib: '103', first_name: 'Mette Maarit',
    last_name: 'Mäkinen', club: 'Vesillä ry',
  });
  // KXW arrives out of order in the JSON — must be sorted by startOrder,
  // and array/object participants + null teamName must be handled.
  assert.deepStrictEqual(lists[1].competitors.map(c => c.bib), ['201', '202']);
  assert.strictEqual(lists[1].competitors[0].first_name, 'Anna');
  assert.strictEqual(lists[1].competitors[0].club, null);
  assert.strictEqual(lists[1].competitors[1].first_name, 'Liisa');
});

test('normalizeStartLists: rejects payloads without start lists', () => {
  assert.throws(() => normalizeStartLists({ foo: 1 }), /no start lists/);
});

// ------------------------------------------------------------------ preview
test('preview: unknown event code warns and blocks saving (spec)', () => {
  const db = open(':memory:');
  const { compId } = seed(db, { events: ['KXM'] });   // KXW missing on purpose
  const p = buildPreview(db, compId, normalizeStartLists(FIXTURE));
  assert.strictEqual(p.can_save, false);
  const kxw = p.start_lists.find(l => l.event_code === 'KXW');
  assert.strictEqual(kxw.event_exists, false);
  assert.match(kxw.warnings[0], /does not exist/);
  // ...and saving must actually be refused, not just discouraged:
  assert.throws(() => saveStartLists(db, compId, normalizeStartLists(FIXTURE)),
    /Cannot save/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM event_athlete').get().c, 0);
});

test('preview: duplicate bib inside the payload and bib already in the event both warn', () => {
  const db = open(':memory:');
  const { compId, eventIds } = seed(db);
  // occupy bib 101 in KXM
  const aid = uuid();
  db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name) VALUES (?, 'X', 'Y')`).run(aid);
  db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order, first_name, last_name)
              VALUES (?, ?, '101', 1, 'X', 'Y')`).run(eventIds.KXM, aid);
  const lists = normalizeStartLists(FIXTURE);
  lists[0].competitors[1].bib = '103';               // now duplicated with row 3
  const p = buildPreview(db, compId, lists);
  assert.strictEqual(p.can_save, false);
  const kxm = p.start_lists[0];
  assert.match(kxm.competitors[0].warnings.join(' '), /already in use/);
  assert.match(kxm.competitors[2].warnings.join(' '), /more than once/);
});

// --------------------------------------------------------------------- save
test('save: inserts athletes + entries; startOrder becomes TT slot_no via list_order', () => {
  const db = open(':memory:');
  const { compId, eventIds } = seed(db);
  const r = saveStartLists(db, compId, normalizeStartLists(FIXTURE));
  assert.strictEqual(r.added, 5);

  const kxm = db.prepare(`SELECT * FROM event_athlete WHERE event_id = ? ORDER BY list_order`)
    .all(eventIds.KXM);
  assert.deepStrictEqual(kxm.map(a => [a.bib, a.first_name, a.last_name, a.club, a.country, a.list_order]), [
    ['101', 'Matti', 'Meikäläinen', 'Koskimelojat', null, 1],
    ['102', 'Teppo', 'Testaaja', 'Kanoottiklubi', null, 2],
    ['103', 'Mette Maarit', 'Mäkinen', 'Vesillä ry', null, 3],
  ]);
  assert.strictEqual(kxm[2].first_name_initial, 'M.');

  // Spec: startOrder = slot_no for the Time Trial. The existing
  // POST /api/phase/start-tt seeds TT from list_order — verify the chain
  // end-to-end using the real API route.
  const { api } = require('../lib/api');
  const routes = api(db, () => {});
  routes['POST /api/phase/start-tt']({}, { event_id: eventIds.KXM });
  const tt = db.prepare(`SELECT ea.bib, r.slot_no FROM result r
                         JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
                         WHERE r.event_id = ? AND r.phase = 'TT' ORDER BY r.slot_no`)
    .all(eventIds.KXM);
  assert.deepStrictEqual(tt.map(r => [r.bib, r.slot_no]),
    [['101', 1], ['102', 2], ['103', 3]]);
});

test('save: re-importing the same list is rejected without duplicating athletes', () => {
  const db = open(':memory:');
  const { compId } = seed(db);
  saveStartLists(db, compId, normalizeStartLists(FIXTURE));
  // second import: bibs are already in use -> blocked at validation
  assert.throws(() => saveStartLists(db, compId, normalizeStartLists(FIXTURE)),
    /already in use/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM athlete').get().c, 5);
});

test('save: transaction — a mid-save failure leaves the database untouched', () => {
  const db = open(':memory:');
  const { compId } = seed(db);
  const lists = normalizeStartLists(FIXTURE);
  // Same athlete (name+club) entered twice in KXM with different bibs:
  // passes bib validation, then trips the "already entered" guard mid-save.
  lists[0].competitors.push({ ...lists[0].competitors[0], start_order: 4, bib: '999' });
  assert.throws(() => saveStartLists(db, compId, lists), /already entered/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM event_athlete').get().c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM athlete').get().c, 0);
});

// -------------------------------------------------------------------- fetch
test('fetchStartLists: correct URL, Bearer auth, and friendly HTTP errors', async () => {
  let seen;
  const okFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => FIXTURE };
  };
  const json = await fetchStartLists('hj15eg09h61j', 'sk_live_test', okFetch);
  assert.strictEqual(seen.url,
    'https://www.starttiin.fi/api/public/races/hj15eg09h61j/starts');
  assert.strictEqual(seen.opts.method, 'GET');
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer sk_live_test');
  assert.strictEqual(json, FIXTURE);

  const status = code => async () => ({ ok: false, status: code, json: async () => ({}) });
  await assert.rejects(fetchStartLists('r', 'k', status(401)), /API-avain/);
  await assert.rejects(fetchStartLists('r', 'k', status(404)), /does not know race/);
  await assert.rejects(fetchStartLists('r', 'k', status(500)), /HTTP 500/);
  await assert.rejects(fetchStartLists('', 'k'), /raceId is required/);
  await assert.rejects(fetchStartLists('r', ''), /API-avain is required/);
});

// ------------------------------------------------------------------- routes
test('routes: fetch returns preview + lists; save confirms and notifies', async () => {
  const db = open(':memory:');
  const { compId, eventIds } = seed(db);
  const notified = [];
  const routes = {};
  attachStarttiin(db, routes, t => notified.push(t),
    async () => ({ ok: true, status: 200, json: async () => FIXTURE }));

  const p = await routes['POST /api/starttiin/fetch']({},
    { competition_id: compId, raceId: 'hj15eg09h61j', apiKey: 'sk_live_test' });
  assert.strictEqual(p.can_save, true);
  assert.strictEqual(p.start_lists.length, 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM event_athlete').get().c, 0,
    'fetch must not write anything (preview only)');

  const r = routes['POST /api/starttiin/save']({}, { competition_id: compId, lists: p.lists });
  assert.strictEqual(r.added, 5);
  assert.ok(notified.includes('athletes') && notified.includes('events'));
  assert.strictEqual(db.prepare(
    'SELECT COUNT(*) AS c FROM event_athlete WHERE event_id = ?').get(eventIds.KXW).c, 2);

  assert.throws(() => routes['POST /api/starttiin/save']({}, { competition_id: compId }),
    /Nothing to save/);
});

// ------------------------------------------------- real starttiin.fi sample
// Regression test against the ACTUAL example response provided with the
// specification (starttiin-startlist.json), not a synthetic stand-in.
test('real sample: normalize, save, and TT slots end-to-end', () => {
  const real = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'starttiin-startlist-real.json'), 'utf8'));
  const lists = normalizeStartLists(real);
  assert.deepStrictEqual(lists.map(l => l.event_code), ['MK1', 'WX1']);
  assert.strictEqual(lists[0].competitors.length, 6);
  // competitionNumber arrives as a NUMBER in the real payload -> bib is TEXT
  assert.deepStrictEqual(lists[0].competitors.map(c => c.bib),
    ['1', '2', '3', '4', '5', '6']);
  assert.deepStrictEqual(lists[1].competitors[0], {
    start_order: 1, bib: '70', first_name: 'Pirkko', last_name: 'Mela',
    club: 'Oulun Seudun Melojat',
  });
  // top-level "registrations" and extra competitor fields must be ignored

  const db = open(':memory:');
  const { compId, eventIds } = seed(db, { events: ['MK1', 'WX1'] });
  const r = saveStartLists(db, compId, lists);
  assert.strictEqual(r.added, 7);
  const { api } = require('../lib/api');
  const routes = api(db, () => {});
  routes['POST /api/phase/start-tt']({}, { event_id: eventIds.MK1 });
  const tt = db.prepare(`SELECT ea.bib, r.slot_no FROM result r
                         JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
                         WHERE r.event_id = ? AND r.phase = 'TT' ORDER BY r.slot_no`)
    .all(eventIds.MK1);
  assert.deepStrictEqual(tt.map(x => [x.bib, x.slot_no]),
    [['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6]]);
});
