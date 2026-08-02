'use strict';

// test/publisher-event-delete.test.js — deleting an event in kx-server must
// (a) cancel every push queued for it and (b) reach the website, which prunes
// events missing from the competition snapshot.
// Run: node --test  (or node test/publisher-event-delete.test.js)

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { open, uuid } = require('../lib/db');
const { api } = require('../lib/api');
const { attachWebPublisher } = require('../lib/publisher-wire');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mocked website ---------------------------------------------------
let webCalls = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  webCalls.push({ url, body });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      updated: body.entries?.length ?? 1,
      payload_hash: crypto.createHash('sha256').update(opts.body).digest('hex')
    })
  };
};

// ---- fixture ----------------------------------------------------------
function seed(db) {
  const compId = uuid();
  const keepId = uuid();
  const dropId = uuid();

  db.prepare(`INSERT INTO competition (competition_id, competition_name, start_date, end_date,
              country, location, time_zone, type, gate_judge_pin, api_key)
              VALUES (?, 'SM Koskicross 2026','2026-08-01','2026-08-02','FIN','Lieksa',
                      'Europe/Helsinki','DOMESTIC','1234', ?)`)
    .run(compId, `${compId}.secret`);

  db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name, gates)
              VALUES (?, ?, 'KXM', 'Kayak Cross Men', 4)`).run(keepId, compId);
  db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name, gates)
              VALUES (?, ?, 'KXW', 'Kayak Cross Women', 4)`).run(dropId, compId);

  db.exec(`CREATE TABLE IF NOT EXISTS server_setting (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  db.prepare('INSERT INTO server_setting (key, value) VALUES (?, ?)')
    .run('web_base_url', 'https://results.example.fi');

  return { compId, keepId, dropId };
}

test('deleting an event cancels its queued pushes and drops it from the snapshot', async () => {
  const db = open(':memory:');
  const { compId, keepId, dropId } = seed(db);

  const routes = {};
  const notified = [];
  const web = attachWebPublisher(db, routes);
  const notify = (topic, detail) => { notified.push(topic); web.onNotify(topic, detail); };
  Object.assign(routes, api(db, notify));

  const { publisher } = web.ensurePublisher(compId);

  // A phase push is in flight (debounced) for the event about to be deleted.
  publisher.publishPhase(dropId, 'QUALIFICATION');
  publisher.publishPhase(keepId, 'QUALIFICATION');
  assert.ok(publisher.status().pendingTargets.some((t) => t.includes(dropId)));

  webCalls = [];
  await routes['DELETE /api/events']({}, { event_id: dropId });

  // (a) nothing queued for the deleted event any more, the other one survives
  const pending = publisher.status().pendingTargets;
  assert.ok(!pending.some((t) => t.includes(dropId)), 'deleted event forgotten');
  assert.ok(pending.some((t) => t.includes(keepId)), 'other event untouched');

  // (b) the competition snapshot that goes out no longer lists the event
  await sleep(2500);
  const push = webCalls.find((c) => c.url.endsWith('/api/v1/competition'));
  assert.ok(push, 'competition snapshot was pushed');
  assert.deepStrictEqual(
    push.body.events.map((e) => e.event_code),
    ['KXM'],
    'snapshot contains only the surviving event'
  );
  assert.ok(
    !webCalls.some((c) => c.url.endsWith('/api/v1/phase') && c.body.event_code === 'KXW'),
    'no phase push for the deleted event'
  );

  await publisher.stop();
});

test('an event with athletes cannot be deleted, and nothing is unqueued', async () => {
  const db = open(':memory:');
  const { compId, dropId } = seed(db);

  const routes = {};
  const web = attachWebPublisher(db, routes);
  Object.assign(routes, api(db, (t, d) => web.onNotify(t, d)));
  const { publisher } = web.ensurePublisher(compId);

  const athleteId = uuid();
  db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, club, country)
              VALUES (?, 'Matti', 'Meikäläinen', 'Koskimelojat', 'FIN')`).run(athleteId);
  db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
              first_name, last_name, club, country)
              VALUES (?, ?, 'RED', 1, 'Matti', 'Meikäläinen', 'Koskimelojat', 'FIN')`)
    .run(dropId, athleteId);

  publisher.publishPhase(dropId, 'QUALIFICATION');

  assert.throws(
    () => routes['DELETE /api/events']({}, { event_id: dropId }),
    /athlete\(s\) uploaded/
  );
  assert.ok(publisher.status().pendingTargets.some((t) => t.includes(dropId)));
  assert.ok(db.prepare('SELECT 1 FROM event WHERE event_id = ?').get(dropId));

  await publisher.stop();
});
