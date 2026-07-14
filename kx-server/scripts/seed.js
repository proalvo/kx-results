// scripts/seed.js — create a demo competition so the Phase page has data.
// Usage: node scripts/seed.js [dbfile]

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { open, uuid } = require('../lib/db');
const { importRuleJson } = require('../lib/progression');

const DB_FILE = process.argv[2] ?? path.join(__dirname, '..', 'kx.db');
if (fs.existsSync(DB_FILE)) {
  console.error(`${DB_FILE} already exists — delete it first to reseed.`);
  process.exit(1);
}
const db = open(DB_FILE);

const compId = uuid();
db.prepare(`INSERT INTO competition (competition_id, competition_name,
  start_date, end_date, country, location, gate_judge_pin)
  VALUES (?, 'Demo Cup 2026', '2026-07-11', '2026-07-12', 'FIN', 'Helsinki', '1234')`)
  .run(compId);

const rule = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'rules', 'rule_12-16_athletes.json'), 'utf8'));
const { ruleId } = importRuleJson(db, rule);

const eventId = uuid();
db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name,
  gates, rule_id) VALUES (?, ?, 'KXM', 'Kayak Cross Men', 6, ?)`)
  .run(eventId, compId, ruleId);

const NAMES = ['Aalto Antti','Bergman Bruno','Carlsson Carl','Degerman Daniel',
  'Eskola Eero','Forsman Frans','Gustafsson Gösta','Heikkinen Heikki',
  'Ilves Ilkka','Järvinen Jussi','Korhonen Kalle','Laine Lauri',
  'Mäkinen Mikko','Niemi Niilo','Ojala Olli'];
NAMES.forEach((full, i) => {
  const [last, first] = full.split(' ');
  const id = uuid();
  db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, club, country)
              VALUES (?, ?, ?, ?, 'FIN')`).run(id, first, last, `Club${i % 4 + 1}`);
  db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
    first_name, first_name_initial, last_name, club, country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FIN')`)
    .run(eventId, id, String(i + 1), i + 1, first, first[0] + '.', last, `Club${i % 4 + 1}`);
});

console.log(`Seeded ${DB_FILE}: Demo Cup 2026, event KXM, 15 athletes, rule imported.`);
console.log('Start the server (node server.js), open http://localhost:3000,');
console.log('click "Create Time Trial start list" and enter times to begin.');
