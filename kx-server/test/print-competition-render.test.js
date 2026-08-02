// test/print-competition-render.test.js — renders public/print-competition.html
// against a minimal stub DOM, so the markup that actually reaches the printer
// is asserted on without needing a browser.
//
// The competition behind it is driven through the real ranking and
// progression engine, so this covers the whole path: engine -> API payload
// -> client render -> printed sheet.
//
//   node --test test/print-competition-render.test.js
//   DUMP_HTML=/tmp/sheets.html node --test test/print-competition-render.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { open, uuid } = require('../lib/db');
const { rankTimeTrial, rankHeat } = require('../lib/ranking');
const { importRuleJson, applyProgression, compileOfficialResult } = require('../lib/progression');
const { buildCompetitionResults } = require('../lib/competition-results');

// ------------------------------------------------------------- sample data
const db = open(':memory:');
const compId = uuid();
db.prepare(`INSERT INTO competition (competition_id, competition_name, start_date,
  end_date, country, location, type, gate_judge_pin)
  VALUES (?, 'Koskicross SM 2026', '2026-08-01', '2026-08-02', 'FIN',
          'Vantaankoski', 'DOMESTIC', '1234')`).run(compId);
// schema default is Europe/Helsinki; make it explicit for the date tests.
db.prepare(`UPDATE competition SET time_zone = 'Europe/Helsinki'
             WHERE competition_id = ?`).run(compId);

const rule = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'rules', 'rule_SMSL2023_8-athletes_B-final.json'), 'utf8'));
const { ruleId } = importRuleJson(db, rule);

function addEvent(code, name, rid) {
  const id = uuid();
  db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name,
    gates, rule_id) VALUES (?, ?, ?, ?, 6, ?)`).run(id, compId, code, name, rid);
  return id;
}
function addAthletes(eventId, names, club, times) {
  const map = {};
  names.forEach((full, i) => {
    const [last, first] = full.split(' ');
    const aid = uuid(); map[String(i + 1)] = aid;
    db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
                VALUES (?,?,?, 'FIN')`).run(aid, first, last);
    db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
      first_name, first_name_initial, last_name, club, country)
      VALUES (?,?,?,?,?,?,?,?, 'FIN')`)
      .run(eventId, aid, String(i + 1), i + 1, first, first[0] + '.', last, club);
    db.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase,
      group_no, slot_no, time_ms) VALUES (?,?,?, 'TT', 1, ?, ?)`)
      .run(uuid(), eventId, aid, i + 1, times[i]);
  });
  return map;
}

// MX1: complete, official.
const mx1 = addEvent('MX1', 'Miesten koskicross', ruleId);
const A = addAthletes(mx1,
  ['Aalto Antti', 'Bergman Bruno', 'Carlsson Carl', 'Degerman Daniel',
   'Eskola Eero', 'Forsman Frans', 'Gustafsson Gosta', 'Heikkinen Heikki'],
  'Vantaan Melojat',
  [60000, 61000, 62000, 63000, 64000, 65000, 66000, 67000]);
rankTimeTrial(db, mx1);
applyProgression(db, mx1, 'TT');
rankHeat(db, mx1, 'SF', 1, ['1', '4', '5', '8']);
rankHeat(db, mx1, 'SF', 2, ['2', '3', '6', '7']);
applyProgression(db, mx1, 'SF');
rankHeat(db, mx1, 'F', 1, ['2', '1', '3', '4']);
// Heikkinen misses gate 3 in the small final — the one marking on the sheet.
const rid = db.prepare(`SELECT result_id FROM result WHERE event_id=? AND athlete_id=?
  AND phase='F' AND group_no=2`).get(mx1, A['8']).result_id;
db.prepare(`INSERT INTO result_penalty (penalty_id, result_id, gate_no, penalty,
  issued_by) VALUES (?,?,3,'FLT','gate-judge:3')`).run(uuid(), rid);
rankHeat(db, mx1, 'F', 2, ['6', '5', '7']);
compileOfficialResult(db, mx1);

// WX1: time trial judged, nothing else — the provisional case.
const wx1 = addEvent('WX1', 'Naisten koskicross', null);
addAthletes(wx1, ['Nieminen Nea', 'Ojala Oona', 'Peltola Pinja'],
  'Tampereen Melojat', [64000, 61500, 62750]);
rankTimeTrial(db, wx1);

const payload = buildCompetitionResults(db, compId);

// --------------------------------------------------------------- stub DOM
const makeEl = (id) => ({
  id, textContent: '', innerHTML: '', checked: false, value: '',
  onclick: null, onchange: null, style: {}, setAttribute() {},
});
const nodes = new Map();
const DEFAULT_ON = ['optProvisional', 'optBib', 'optFault', 'optSignature'];
for (const id of ['sheets', 'errorNote', 'status', 'eventPicker', 'printBtn',
  'optProvisional', 'optBib', 'optFault', 'optTT', 'optRound', 'optSignature']) {
  const el = makeEl(id);
  el.checked = DEFAULT_ON.includes(id);
  nodes.set(id, el);
}

// The page only ever queries '.ev' (the event picker checkboxes). These are
// stable objects so the onchange handlers renderPicker() attaches survive,
// and a "click" can be simulated by flipping .checked and calling it.
const evBoxes = payload.events.map(e => ({ value: e.event_id, checked: true }));
const document = {
  title: '',
  getElementById: (id) => nodes.get(id) ?? makeEl(id),
  querySelectorAll: () => evBoxes,
};

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const responses = {
  '/api/competition-results': payload,
  '/api/competition/': { header: PNG, footer: null },   // pdf-branding
};
const fetchStub = (url) => Promise.resolve({
  ok: true,
  json: () => Promise.resolve(
    responses[Object.keys(responses).find(k => url.startsWith(k))]),
});

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'print-competition.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const sandbox = {
  document, fetch: fetchStub, console,
  location: { search: '?competition_id=' + compId },
  URLSearchParams, Promise, Set, Date, Array, Object, JSON, Math, String, Number,
  window: { print() {} },
};
vm.createContext(sandbox);
vm.runInContext(script, sandbox);

// main() is async over resolved promises; a turn of the loop is enough.
const ready = new Promise(r => setTimeout(r, 50));
const out = () => nodes.get('sheets').innerHTML;
const rerender = () => { nodes.get('optTT').onchange(); return out(); };
const sheetFor = (code) => {
  const all = out().split('<div class="sheet">');
  return all.find(s => s.includes(code)) ?? '';
};

// -------------------------------------------------------------- the tests
test('one A4 sheet per event, laid out like print.html', async () => {
  await ready;
  assert.equal((out().match(/<div class="sheet">/g) || []).length, 2);
  assert.equal((out().match(/class="sheetHeader"/g) || []).length, 2);
  assert.equal((out().match(/class="sheetFooter"/g) || []).length, 2);
});

test('each sheet names the competition, the event and the venue', async () => {
  await ready;
  const s = sheetFor('MX1');
  assert.match(s, /<div class="comp">Koskicross SM 2026 — Miesten koskicross<\/div>/);
  assert.match(s, /<h1>Official Result: MX1/);
  // Finnish competition -> Finnish date convention, not the printer's.
  assert.match(s, /<div class="meta">Vantaankoski · 01\.08\.2026 – 02\.08\.2026<\/div>/);
});

test('the header image is a full-width banner on every sheet', async () => {
  await ready;
  assert.equal((out().match(/<div class="headerLogo"><img src="data:image\/png/g) || []).length, 2);
  // No footer image uploaded -> the slot stays empty and invisible.
  assert.match(out(), /<div class="footerLogo"><\/div>/);
});

test('both banner boxes span the full printable width, capped in height', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'print-competition.html'), 'utf8');
  for (const box of ['headerLogo', 'footerLogo']) {
    const rule = css.match(new RegExp(`\\.${box} img \\{[^}]*\\}`))[0];
    assert.match(rule, /width:\s*100%/, `${box} must span the page width`);
    assert.match(rule, /height:\s*auto/, `${box} must keep its aspect ratio`);
    // Guard so a squarish upload cannot swallow the sheet.
    assert.match(rule, /max-height:\s*\d+px/, `${box} needs a height guard`);
    assert.match(rule, /object-fit:\s*contain/);
  }
  // The banner must precede the titles, i.e. sit at the very top like a letterhead.
  assert.ok(css.indexOf('<div class="headerLogo">') < css.indexOf('<div class="titles">'));
});

test('every sheet is stamped in the competition\'s own date and time format', async () => {
  await ready;
  const stamps = out().match(/Printed [^<]+/g) || [];
  assert.equal(stamps.length, 2);
  // FIN + Europe/Helsinki -> dd.mm.yyyy klo hh.mm.ss, with a full year.
  assert.match(stamps[0], /^Printed \d{2}\.\d{2}\.\d{4} klo \d{2}\.\d{2}\.\d{2}$/);
});

test('timestamps follow the competition country and time zone, not the printer', () => {
  const { formatStamp, formatDate } = sandbox;
  const iso = '2026-08-01T14:05:09Z';
  const at = (country, time_zone) => formatStamp(iso, { country, time_zone });

  // Same instant, four venues: local convention AND local wall clock.
  assert.equal(at('FIN', 'Europe/Helsinki'), '01.08.2026 klo 17.05.09');
  assert.equal(at('GER', 'Europe/Berlin'),   '01.08.2026, 16:05:09');
  assert.equal(at('GBR', 'Europe/London'),   '01/08/2026, 15:05:09');
  assert.match(at('USA', 'America/New_York'), /^08\/01\/2026, 10:05:09\s?AM$/);

  // An IOC code is not an ISO code — 'en-FIN' throws in Intl — so unmapped
  // codes must fall back, not blow up the whole sheet.
  assert.equal(at('XXX', 'Europe/Helsinki'), '01/08/2026, 17:05:09');
  // An unknown IANA zone degrades to the local convention rather than throwing.
  assert.equal(at('FIN', 'Not/AZone'), '01.08.2026 klo 14.05.09');

  // Archival document: never a two-digit year.
  for (const c of ['FIN', 'USA', 'GER', 'GBR', 'JPN']) {
    assert.match(at(c, 'UTC'), /2026/, `${c} must print a four-digit year`);
  }

  // A stored 'YYYY-MM-DD' has no time of day and must never shift a day
  // across the date line when formatted for a western zone.
  assert.equal(formatDate('2026-08-01', { country: 'USA', time_zone: 'Pacific/Honolulu' }),
    '08/01/2026');
  assert.equal(formatDate('2026-08-01', { country: 'FIN' }), '01.08.2026');
  assert.equal(formatDate(null, { country: 'FIN' }), '');
});

test('official event: full classification in rank order, correct columns', async () => {
  await ready;
  const s = sheetFor('MX1');
  assert.match(s, /<span class="badge official">Official<\/span>/);
  const heads = [...s.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(heads, ['Rank', 'Bib', 'Name', 'Club / Country', 'Fault']);
  const ranks = [...s.matchAll(/<td class="num">(\d+)<\/td>\s*<td class="num">/g)]
    .map(m => +m[1]);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('names print surname-first and use the club/country rule, as print.html does', async () => {
  await ready;
  const s = sheetFor('MX1');
  const firstRow = s.match(/<tbody><tr>([\s\S]*?)<\/tr>/)[1];
  assert.match(firstRow, /<td class="num">2<\/td>/);        // winner's bib
  assert.match(firstRow, /<td>Bergman Bruno<\/td>/);
  // DOMESTIC competition -> club, not country.
  assert.match(firstRow, /<td>Vantaan Melojat<\/td>/);
  assert.ok(!/<td>FIN<\/td>/.test(firstRow));
});

test('Fault column uses print.html format and only where there is a fault', async () => {
  await ready;
  const s = sheetFor('MX1');
  const cells = s.match(/<td class="timing[^"]*">([^<]*)<\/td>/g) || [];
  assert.equal(cells.length, 8, 'one fault cell per athlete');
  assert.deepEqual(cells.filter(c => !/>\s*</.test(c)),
    ['<td class="timing fault">FLT @ G3</td>']);
});

test('no run-time column, and the optional columns are off by default', async () => {
  await ready;
  assert.ok(!/>Time<\/th>/.test(out()));
  assert.ok(!/>Time Trial<\/th>/.test(out()));
  assert.ok(!/>Eliminated in<\/th>/.test(out()));
});

test('an unfinished event is badged provisional and explains itself', async () => {
  await ready;
  const s = sheetFor('WX1');
  assert.match(s, /<span class="badge provisional">Provisional<\/span>/);
  // The words "Official Result" must appear nowhere on an unfinished sheet.
  assert.match(s, /<h1>Provisional Result: WX1/);
  assert.ok(!/Official Result/.test(s), 'no "Official Result" on a provisional sheet');
  assert.match(s, /class="caveat">No official classification has been compiled/);
  // Ordered by time trial: Ojala 61.5, Peltola 62.75, Nieminen 64.0
  assert.deepEqual([...s.matchAll(/<td>(\w+ \w+)<\/td>\s*<td>Tampereen/g)].map(m => m[1]),
    ['Ojala Oona', 'Peltola Pinja', 'Nieminen Nea']);
});

test('one signature line, for the Chief Judge only', async () => {
  await ready;
  assert.equal((out().match(/Chief Judge — signature \/ date/g) || []).length, 2);
  assert.ok(!/Chief of Scoring/.test(out()), 'Chief of Scoring line was removed');
});

test('a one-day competition prints a single date, not a range', async () => {
  await ready;
  const { renderSheet } = sandbox;
  const ev = payload.events[0];
  const oneDay = { ...payload.competition, start_date: '2026-08-01', end_date: '2026-08-01' };
  const html = renderSheet(ev, oneDay, { header: null, footer: null });
  assert.match(html, /<div class="meta">Vantaankoski · 01\.08\.2026<\/div>/);
  assert.ok(!/–/.test(html.match(/<div class="meta">[^<]*<\/div>/)[0]));

  // A missing end date behaves the same way.
  const noEnd = { ...payload.competition, end_date: null };
  assert.match(renderSheet(ev, noEnd, { header: null, footer: null }),
    /<div class="meta">Vantaankoski · 01\.08\.2026<\/div>/);

  // ...and a real multi-day competition still shows the range.
  assert.match(renderSheet(ev, payload.competition, { header: null, footer: null }),
    /<div class="meta">Vantaankoski · 01\.08\.2026 – 02\.08\.2026<\/div>/);
});

test('Bib and Fault can each be switched off independently', async () => {
  await ready;
  // Read the header row of the FIRST sheet only — a fixed slice would run
  // into the next sheet's headers as soon as a column is removed.
  const cols = () => [...sheetFor('MX1').match(/<thead><tr>([\s\S]*?)<\/tr>/)[1]
    .matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map(m => m[1]);

  assert.deepEqual(cols(), ['Rank', 'Bib', 'Name', 'Club / Country', 'Fault']);

  nodes.get('optBib').checked = false;
  let s2 = rerender();
  assert.deepEqual(cols(), ['Rank', 'Name', 'Club / Country', 'Fault']);
  // Header and body must drop together or every row shifts one column left.
  const row = s2.match(/<tbody><tr>([\s\S]*?)<\/tr>/)[1];
  assert.equal((row.match(/<td class="num">/g) || []).length, 1, 'only Rank remains numeric');
  assert.match(row, /<td>Bergman Bruno<\/td>/);

  nodes.get('optFault').checked = false;
  rerender();
  assert.deepEqual(cols(), ['Rank', 'Name', 'Club / Country']);
  assert.ok(!/FLT @ G3/.test(out()), 'the fault text goes with its column');

  nodes.get('optBib').checked = true;
  rerender();
  assert.deepEqual(cols(), ['Rank', 'Bib', 'Name', 'Club / Country']);

  nodes.get('optFault').checked = true;
  rerender();
  assert.deepEqual(cols(), ['Rank', 'Bib', 'Name', 'Club / Country', 'Fault']);
  assert.match(out(), /FLT @ G3/);
});

test('optional columns render when switched on', async () => {
  await ready;
  nodes.get('optTT').checked = true;
  nodes.get('optRound').checked = true;
  const s2 = rerender();
  assert.match(s2, />Time Trial<\/th>/);
  assert.match(s2, />Eliminated in<\/th>/);
  assert.match(s2, /<td class="timing">1:07\.00<\/td>/);     // Heikkinen's 67.000 s
  assert.match(s2, /<td class="round">Final 2<\/td>/);
  assert.match(s2, /<td class="round">Time Trial<\/td>/);    // WX1, never past TT
});

test('unchecking "include unfinished events" drops the provisional sheet', async () => {
  await ready;
  nodes.get('optProvisional').checked = false;
  const s3 = rerender();
  assert.ok(!/Naisten koskicross/.test(s3));
  assert.match(s3, /Miesten koskicross/);
  assert.equal((s3.match(/<div class="sheet">/g) || []).length, 1);
});

test('the event picker prints only the events that are ticked', async () => {
  await ready;
  nodes.get('optProvisional').checked = true;
  nodes.get('optTT').checked = false;
  nodes.get('optRound').checked = false;
  assert.match(nodes.get('eventPicker').innerHTML, /value="[^"]+"[^>]*>\s*MX1/);

  // Untick MX1 in the picker.
  evBoxes.find(b => b.value === payload.events[0].event_id).checked = false;
  evBoxes[0].onchange();
  assert.ok(!/Miesten koskicross/.test(out()));
  assert.match(out(), /Naisten koskicross/);

  // Untick everything: say so rather than emit an empty sheet.
  evBoxes.forEach(b => { b.checked = false; });
  evBoxes[0].onchange();
  assert.equal(out(), '');
  assert.equal(nodes.get('errorNote').textContent, 'Nothing selected to print.');

  // ...and back again.
  evBoxes.forEach(b => { b.checked = true; });
  evBoxes[0].onchange();
  assert.equal((out().match(/<div class="sheet">/g) || []).length, 2);
  assert.equal(nodes.get('errorNote').textContent, '');
});

test('affiliation follows the competition type, exactly as print.html', async () => {
  await ready;
  const { affiliation } = sandbox;
  const athlete = { club: 'Vantaan Melojat', country: 'FIN' };
  const foreign = { club: 'Wildwater Wien', country: 'AUT' };
  assert.equal(affiliation(athlete, { type: 'DOMESTIC', country: 'FIN' }), 'Vantaan Melojat');
  assert.equal(affiliation(athlete, { type: 'INTERNATIONAL', country: 'FIN' }), 'FIN');
  assert.equal(affiliation(athlete, { type: 'MIXED', country: 'FIN' }), 'Vantaan Melojat');
  assert.equal(affiliation(foreign, { type: 'MIXED', country: 'FIN' }), 'AUT');

  if (process.env.DUMP_HTML) {
    nodes.get('optProvisional').checked = true;
    fs.writeFileSync(process.env.DUMP_HTML, rerender());
  }
});
