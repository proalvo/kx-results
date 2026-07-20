'use strict';

// test/publisher.test.js — integration test of the KX-Web publisher against
// the REAL kx-server schema in an in-memory node:sqlite database, with the
// website mocked. Run: node --test  (or node test/publisher.test.js)

const test = require('node:test');
const assert = require('node:assert');
const { open, uuid } = require('../lib/db');
const payloads = require('../lib/publisher-payloads');
const { attachWebPublisher } = require('../lib/publisher-wire');

// ---- fixture ---------------------------------------------------------
function seed(db) {
  const compId = uuid(), eventId = uuid();
  db.prepare(`INSERT INTO competition (competition_id, competition_name, start_date, end_date,
              country, location, time_zone, type, gate_judge_pin)
              VALUES (?, 'SM Koskicross 2026','2026-08-01','2026-08-02','FIN','Lieksa','Europe/Helsinki','DOMESTIC','1234')`)
    .run(compId);
  db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name, gates)
              VALUES (?, ?, 'KXM', 'Kayak Cross Men', 4)`).run(eventId, compId);

  const athletes = [
    ['Matti', 'Meikäläinen', 'Koskimelojat', 'FIN', 'RED'],
    ['Teppo', 'Testaaja', 'Kanoottiklubi', 'FIN', 'BLUE']
  ];
  const resultIds = [];
  athletes.forEach(([fn, ln, club, country, bib], i) => {
    const aid = uuid();
    db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, club, country)
                VALUES (?, ?, ?, ?, ?)`).run(aid, fn, ln, club, country);
    db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order, first_name, last_name, club, country)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventId, aid, bib, i + 1, fn, ln, club, country);
    const rid = uuid();
    db.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase, group_no, slot_no)
                VALUES (?, ?, ?, 'Q', 1, ?)`).run(rid, eventId, aid, i + 1);
    resultIds.push(rid);
  });
  return { compId, eventId, resultIds };
}

// ---- mocked website ---------------------------------------------------
let webCalls = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  webCalls.push({ url, body });
  return {
    ok: true, status: 200,
    json: async () => ({
      ok: true, updated: body.entries?.length ?? 1,
      payload_hash: require('node:crypto').createHash('sha256').update(opts.body).digest('hex')
    })
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('payloads: phase snapshot from real schema (penalties, status, colour bibs)', () => {
  const db = open(':memory:');
  const { eventId, resultIds } = seed(db);

  // penalties: FLT gate 2 (later revoked), RAL gate 3; DNF for athlete 2
  const p1 = uuid();
  db.prepare(`INSERT INTO result_penalty (penalty_id, result_id, gate_no, penalty, issued_by)
              VALUES (?, ?, 2, 'FLT', 'gate-judge:2')`).run(p1, resultIds[0]);
  db.prepare(`INSERT INTO result_penalty (penalty_id, result_id, gate_no, penalty, issued_by)
              VALUES (?, ?, 3, 'RAL', 'gate-judge:3')`).run(uuid(), resultIds[0]);
  db.prepare(`UPDATE result SET status = 'DNF' WHERE result_id = ?`).run(resultIds[1]);

  let snap = payloads.buildPhaseSync(db, eventId, 'QUALIFICATION');
  assert.strictEqual(snap.event_code, 'KXM');
  assert.strictEqual(snap.entries.length, 2);
  const [e1, e2] = snap.entries;
  assert.strictEqual(e1.bib, 'RED');                       // TEXT bib survives
  assert.deepStrictEqual(e1.gates, [null, 1, 2, null]);    // FLT=1, RAL=2
  assert.strictEqual(e1.ral, true);
  assert.strictEqual(e2.dnf, true);

  // revoke the FLT -> disappears from the snapshot
  db.prepare(`UPDATE result_penalty SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE penalty_id = ?`).run(p1);
  snap = payloads.buildPhaseSync(db, eventId, 'QUALIFICATION');
  assert.deepStrictEqual(snap.entries[0].gates, [null, null, 2, null]);
});

test('deriveStatus: live_tracking wins; RESULT is official', () => {
  const db = open(':memory:');
  const { eventId } = seed(db);
  db.prepare(`UPDATE event SET live_tracking = 1, current_phase = 'Q' WHERE event_id = ?`).run(eventId);
  assert.strictEqual(payloads.buildPhaseSync(db, eventId, 'QUALIFICATION').status, 'live');
});

test('wire: register -> notify(results) publishes only dirty phases', async () => {
  const db = open(':memory:');
  const { compId, eventId } = seed(db);
  webCalls = [];

  const routes = {};
  const web = attachWebPublisher(db, routes);

  // register (mock returns 201 shape through generic mock? use direct settings)
  global.fetch = async (url, opts) => {                       // registration mock
    if (url.endsWith('/api/v1/competitions')) {
      return { status: 201, json: async () => ({ ok: true, api_key: compId + '.sec', slug: 'sm-2026', public_url: '/c/sm-2026' }) };
    }
    const body = JSON.parse(opts.body);
    webCalls.push({ url, body });
    return { ok: true, status: 200, json: async () => ({ ok: true, updated: 1,
      payload_hash: require('node:crypto').createHash('sha256').update(opts.body).digest('hex') }) };
  };

  // settings are server-wide: save once, register without inline credentials
  await routes['POST /api/web/settings']({}, {
    web_base_url: 'https://example.fi/kx-results/', org_key: 'org.o1.k'
  });
  const st = await routes['GET /api/web/settings']({}, {});
  assert.strictEqual(st.web_base_url, 'https://example.fi/kx-results'); // trailing / stripped
  assert.strictEqual(st.org_key_set, true);                            // key never echoed
  assert.strictEqual('org_key' in st, false);

  const r = await routes['POST /api/web/register']({}, { competition_id: compId });
  assert.strictEqual(r.slug, 'sm-2026');
  assert.strictEqual(
    db.prepare('SELECT api_key FROM competition WHERE competition_id = ?').get(compId).api_key,
    compId + '.sec'
  );
  await sleep(50); // initial publishFull fires

  // a gate judge penalty arrives -> result row touched -> notify('results')
  webCalls = [];
  await sleep(10); // ensure watermark < updated_at
  const rid = db.prepare(`SELECT result_id FROM result LIMIT 1`).get().result_id;
  db.prepare(`UPDATE result SET rank = 1 WHERE result_id = ?`).run(rid);
  web.onNotify('results');

  // publisher debounce is 2 s by default — wait it out
  await sleep(2300);
  const phasePushes = webCalls.filter((c) => c.url.endsWith('/api/v1/phase'));
  assert.strictEqual(phasePushes.length, 1, 'exactly the one dirty phase is pushed');
  assert.strictEqual(phasePushes[0].body.phase, 'QUALIFICATION');
  assert.strictEqual(phasePushes[0].body.entries.some((e) => e.rank === 1), true);

  // unrelated topic -> nothing
  webCalls = [];
  web.onNotify('rules');
  await sleep(2300);
  assert.strictEqual(webCalls.length, 0);
});

test('wire: publish-official overrides derived status', async () => {
  const db = open(':memory:');
  const { compId, eventId } = seed(db);
  db.prepare('UPDATE competition SET api_key = ? WHERE competition_id = ?').run(compId + '.sec', compId);
  const routes = {};
  attachWebPublisher(db, routes);
  db.prepare(`INSERT INTO server_setting (key, value) VALUES ('web_base_url', 'https://x')`).run();

  webCalls = [];
  global.fetch = async (url, opts) => {
    webCalls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, updated: 2, payload_hash: 'h' }) };
  };
  const r = await routes['POST /api/web/publish-official']({}, {
    competition_id: compId, event_id: eventId, phase: 'Q'
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(webCalls[0].body.status, 'official');
});
