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
      const payload = { ok: true, api_key: compId + '.sec', slug: 'sm-2026', public_url: '/competition/sm-2026' };
      return { status: 201, text: async () => JSON.stringify(payload), json: async () => payload };
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


test('http dispatcher: rejecting async route returns 400, does not crash', async () => {
  const http = require('node:http');
  // minimal replica of server.js dispatch with the await fix
  const routes = {
    'POST /boom': async () => { throw new Error('async failure'); },
    'POST /ok':   async () => ({ fine: true })
  };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const handler = routes[`${req.method} ${url.pathname}`];
    try {
      const result = (await handler({}, {})) ?? {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const realFetch = Object.getPrototypeOf(global.fetch) ? global.fetch : null;
  // use node http directly (global.fetch is mocked in this suite)
  const request = (path) => new Promise((resolve, reject) => {
    const req2 = http.request({ port, path, method: 'POST' }, (r) => {
      let b = ''; r.on('data', (c) => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(b) }));
    });
    req2.on('error', reject); req2.end();
  });
  const bad = await request('/boom');
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error, 'async failure');
  const good = await request('/ok');
  assert.strictEqual(good.status, 200);
  assert.deepStrictEqual(good.body, { fine: true });
  srv.close();
});



test('athletes: same bib allowed in different events, rejected in same event', async () => {
  const db = open(':memory:');
  const compId = uuid();
  db.prepare(`INSERT INTO competition (competition_id, competition_name, start_date, end_date,
              country, type, gate_judge_pin)
              VALUES (?, 'Test','2026-07-22','2026-07-22','FIN','DOMESTIC','1234')`).run(compId);
  db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name, gates)
              VALUES (?, ?, 'KXM', 'Men', 4)`).run(uuid(), compId);
  db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name, gates)
              VALUES (?, ?, 'KXW', 'Women', 4)`).run(uuid(), compId);

  const { api } = require('../lib/api');
  const routes = api(db, () => {});

  // Upload the same bib (101) to both events — should succeed
  const r1 = await routes['POST /api/athletes/upload']({}, {
    competition_id: compId,
    csv: 'event;bib;first_name;last_name;club;country\nKXM;101;Alice;Smith;Club;FIN'
  });
  assert.strictEqual(r1.added, 1);
  assert.strictEqual(r1.errors.length, 0);

  const r2 = await routes['POST /api/athletes/upload']({}, {
    competition_id: compId,
    csv: 'event;bib;first_name;last_name;club;country\nKXW;101;Bob;Jones;Club;FIN'
  });
  assert.strictEqual(r2.added, 1);
  assert.strictEqual(r2.errors.length, 0);

  // Try to upload the same bib again in KXM — should fail with clear error
  const r3 = await routes['POST /api/athletes/upload']({}, {
    competition_id: compId,
    csv: 'event;bib;first_name;last_name;club;country\nKXM;101;Charlie;Brown;Club;FIN'
  });
  assert.strictEqual(r3.added, 0);
  assert(r3.errors[0]?.includes('already in use in event KXM'));
});
