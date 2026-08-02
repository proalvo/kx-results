// test/print-competition-http.test.js — the overall results sheet over real
// HTTP, through the real server: static page, the two endpoints the page
// calls, and the path-parameter route dispatch they depend on.
//
// The dispatch part is not incidental. setup.html uploads the PDF logos to
// /api/competition/{uuid}/pdf-header, but server.js used to look handlers up
// by literal pathname only, so ':id' never matched and every upload answered
// 404 — meaning no competition could ever have a header or footer image.
// These tests pin the fix down.
//
//   node --test test/print-competition-http.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// server.js reads its database path from argv; keep the suite in memory.
process.argv[2] = ':memory:';
const { server, db } = require('../server');
const { uuid } = require('../lib/db');
const { rankTimeTrial, rankHeat } = require('../lib/ranking');
const { importRuleJson, applyProgression, compileOfficialResult } = require('../lib/progression');

// ------------------------------------------------------------------- seed
const compId = uuid();
db.prepare(`INSERT INTO competition (competition_id, competition_name, start_date,
  end_date, country, location, type, gate_judge_pin)
  VALUES (?, 'Koskicross SM 2026', '2026-08-01', '2026-08-02', 'FIN',
          'Vantaankoski', 'DOMESTIC', '1234')`).run(compId);
db.prepare(`INSERT INTO app_state (state_key, active_competition_id)
            VALUES ('active', ?)`).run(compId);

const rule = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'rules', 'rule_SMSL2023_8-athletes_B-final.json'), 'utf8'));
const { ruleId } = importRuleJson(db, rule);

const eventId = uuid();
db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name,
  gates, rule_id) VALUES (?, ?, 'MX1', 'Miesten koskicross', 6, ?)`)
  .run(eventId, compId, ruleId);
['Aalto Antti', 'Bergman Bruno', 'Carlsson Carl', 'Degerman Daniel',
 'Eskola Eero', 'Forsman Frans', 'Gustafsson Gosta', 'Heikkinen Heikki']
  .forEach((full, i) => {
    const [last, first] = full.split(' ');
    const aid = uuid();
    db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
                VALUES (?,?,?, 'FIN')`).run(aid, first, last);
    db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
      first_name, first_name_initial, last_name, club, country)
      VALUES (?,?,?,?,?,?,?, 'Vantaan Melojat', 'FIN')`)
      .run(eventId, aid, String(i + 1), i + 1, first, first[0] + '.', last);
    db.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase,
      group_no, slot_no, time_ms) VALUES (?,?,?, 'TT', 1, ?, ?)`)
      .run(uuid(), eventId, aid, i + 1, 59000 + (i + 1) * 1000);
  });
rankTimeTrial(db, eventId);
applyProgression(db, eventId, 'TT');
rankHeat(db, eventId, 'SF', 1, ['1', '4', '5', '8']);
rankHeat(db, eventId, 'SF', 2, ['2', '3', '6', '7']);
applyProgression(db, eventId, 'SF');
rankHeat(db, eventId, 'F', 1, ['2', '1', '3', '4']);
rankHeat(db, eventId, 'F', 2, ['6', '5', '7', '8']);
compileOfficialResult(db, eventId);

// A second event left unfinished, so the provisional path is exercised too.
const evt2 = uuid();
db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name,
  gates, rule_id) VALUES (?, ?, 'WX1', 'Naisten koskicross', 6, NULL)`)
  .run(evt2, compId);
['Nieminen Nea', 'Ojala Oona', 'Peltola Pinja'].forEach((full, i) => {
  const [last, first] = full.split(' ');
  const aid = uuid();
  db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
              VALUES (?,?,?, 'FIN')`).run(aid, first, last);
  db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
    first_name, first_name_initial, last_name, club, country)
    VALUES (?,?,?,?,?,?,?, 'Tampereen Melojat', 'FIN')`)
    .run(evt2, aid, String(i + 1), i + 1, first, first[0] + '.', last);
  db.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase,
    group_no, slot_no, time_ms) VALUES (?,?,?, 'TT', 1, ?, ?)`)
    .run(uuid(), evt2, aid, i + 1, [64000, 61500, 62750][i]);
});
rankTimeTrial(db, evt2);

// ------------------------------------------------------------------ drive
let base;
test.before(async () => {
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const GET = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, type: res.headers.get('content-type'),
           body: await res.text() };
};
const send = async (method, p, body) => {
  const res = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
};

// --------------------------------------------------- path-parameter routes
test('logo upload reaches its handler instead of 404ing on the static tree', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const up = await send('POST', `/api/competition/${compId}/pdf-header`,
    { image: png, filename: 'club-logo.png' });
  assert.equal(up.status, 200);
  assert.deepEqual(JSON.parse(up.body), { ok: true });
  assert.equal(db.prepare(
    'SELECT pdf_header_filename AS f FROM competition WHERE competition_id = ?')
    .get(compId).f, 'club-logo.png');
});

test('exact-path routes and the static tree are unaffected by param matching', async () => {
  assert.equal((await GET('/api/competitions')).status, 200);
  assert.equal((await GET('/print-competition.html')).status, 200);
  assert.equal((await GET('/api/competition/nope/not-a-route')).status, 404);
  assert.equal((await GET('/api/nothing-here')).status, 404);
});

test('a bad competition id in the path still gets a readable 400', async () => {
  const r = await send('POST', '/api/competition/does-not-exist/pdf-header',
    { image: 'aGk=', filename: 'x.png' });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /Competition not found/);
});

// -------------------------------------------------- what the page fetches
test('the print page is served as html with its logo extension points', async () => {
  const page = await GET('/print-competition.html');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /class="headerLogo"/);
  assert.match(page.body, /class="footerLogo"/);
  assert.match(page.body, /competition-results/);
});

test('the page can find the competition with no query string at all', async () => {
  const s = JSON.parse((await GET('/api/app-state')).body);
  assert.equal(s.active_competition_id, compId);
});

test('GET pdf-branding returns the header as a data URL, absent footer as null', async () => {
  const b = JSON.parse((await GET(`/api/competition/${compId}/pdf-branding`)).body);
  assert.match(b.header, /^data:image\/png;base64,iVBORw0KGgo=$/);
  assert.equal(b.header_filename, 'club-logo.png');
  assert.equal(b.footer, null);
});

test('a JPG footer is served with the right MIME, and clearing it works', async () => {
  await send('POST', `/api/competition/${compId}/pdf-footer`,
    { image: Buffer.from('ffd8ff', 'hex').toString('base64'), filename: 'sponsors.JPG' });
  let b = JSON.parse((await GET(`/api/competition/${compId}/pdf-branding`)).body);
  assert.match(b.footer, /^data:image\/jpeg;base64,/);

  assert.equal((await send('DELETE', `/api/competition/${compId}/pdf-footer`)).status, 200);
  b = JSON.parse((await GET(`/api/competition/${compId}/pdf-branding`)).body);
  assert.equal(b.footer, null);
  assert.match(b.header, /^data:image\/png/, 'clearing one must not clear the other');
});

test('an SVG logo survives the round trip with a MIME an <img> will render', async () => {
  // Vector is the right format for branding that ends up in a PDF: no
  // resolution to get wrong, sharp at any zoom, and a fraction of the bytes.
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60">' +
    '<rect width="200" height="60" fill="#16324a"/></svg>');
  await send('POST', `/api/competition/${compId}/pdf-header`,
    { image: svg.toString('base64'), filename: 'club-logo.svg' });

  const b = JSON.parse((await GET(`/api/competition/${compId}/pdf-branding`)).body);
  assert.match(b.header, /^data:image\/svg\+xml;base64,/,
    'served as image/png an <img> would refuse to render it');
  assert.equal(Buffer.from(b.header.split(',')[1], 'base64').toString(),
    svg.toString(), 'bytes must survive unaltered');

  // Put the PNG back for the remaining tests.
  await send('POST', `/api/competition/${compId}/pdf-header`,
    { image: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
      filename: 'club-logo.png' });
});

test('GET competition-results serves the whole competition', async () => {
  const res = await GET(`/api/competition-results?competition_id=${compId}`);
  assert.equal(res.status, 200);
  assert.match(res.type, /application\/json/);
  const doc = JSON.parse(res.body);
  assert.equal(doc.competition.competition_name, 'Koskicross SM 2026');
  assert.deepEqual(doc.events.map(e => e.event_code), ['MX1', 'WX1']);

  const mx1 = doc.events[0];
  assert.equal(mx1.status, 'OFFICIAL');
  assert.deepEqual(mx1.rows.map(r => r.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(mx1.rows.map(r => r.bib), ['2', '1', '3', '4', '6', '5', '7', '8']);
  assert.equal(mx1.rows[0].last_name, 'Bergman');
  assert.deepEqual(mx1.unclassified, []);

  const wx1 = doc.events[1];
  assert.equal(wx1.status, 'PROVISIONAL');
  assert.deepEqual(wx1.rows.map(r => r.bib), ['2', '3', '1']);
});

test('event_ids and include_provisional narrow what gets printed', async () => {
  const one = JSON.parse((await GET(
    `/api/competition-results?competition_id=${compId}&event_ids=${eventId}`)).body);
  assert.deepEqual(one.events.map(e => e.event_code), ['MX1']);

  const strict = JSON.parse((await GET(
    `/api/competition-results?competition_id=${compId}&include_provisional=0`)).body);
  assert.equal(strict.events.find(e => e.event_code === 'WX1').status, 'PENDING');
});

test('a missing competition_id is a 400 the page can show, not a crash', async () => {
  const r = await GET('/api/competition-results');
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /competition_id is required/);
});

test('printing is read-only: two fetches return an identical document', async () => {
  const a = JSON.parse((await GET(`/api/competition-results?competition_id=${compId}`)).body);
  const b = JSON.parse((await GET(`/api/competition-results?competition_id=${compId}`)).body);
  assert.deepEqual(a.events, b.events);
});
