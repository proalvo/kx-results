// scripts/seed-custom.js — seed a demo competition with a chosen rule and
// athlete count, for hands-on testing in the browser.
//
// Usage:
//   node scripts/seed-custom.js <dbfile> <ruleJson> <athleteCount>
//
// Example (19 athletes against the RQ-phase rule):
//   node scripts/seed-custom.js kx19.db rules/rule_19-20_athletes.json 19
//
// Rule name, description, and min/max athlete range all come from the
// JSON file itself — see /rules/*.json for the format and worked examples.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { open, uuid } = require('../lib/db');
const { importRuleJson } = require('../lib/progression');

const [, , dbArg, ruleArg, countArg] = process.argv;
if (!dbArg || !ruleArg || !countArg) {
  console.error('Usage: node scripts/seed-custom.js <dbfile> <ruleJson> <athleteCount>');
  console.error('Example: node scripts/seed-custom.js kx19.db rules/rule_19-20_athletes.json 19');
  process.exit(1);
}
const DB_FILE = path.resolve(dbArg);
const RULE_FILE = path.resolve(ruleArg);
const N = +countArg;

if (fs.existsSync(DB_FILE)) {
  console.error(`${DB_FILE} already exists — delete it first to reseed.`);
  process.exit(1);
}
const db = open(DB_FILE);

const compId = uuid();
db.prepare(`INSERT INTO competition (competition_id, competition_name,
  start_date, end_date, country, location, gate_judge_pin)
  VALUES (?, ?, '2026-07-11', '2026-07-12', 'FIN', 'Helsinki', '1234')`)
  .run(compId, `Test Cup (${N} athletes)`);

const rule = JSON.parse(fs.readFileSync(RULE_FILE, 'utf8'));
const { ruleId, steps } = importRuleJson(db, rule);

const eventId = uuid();
db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name,
  gates, rule_id) VALUES (?, ?, 'KXM', 'Kayak Cross Men', 6, ?)`)
  .run(eventId, compId, ruleId);

const FIRST = ['Aalto','Bergman','Carlsson','Degerman','Eskola','Forsman','Gustafsson',
  'Heikkinen','Ilves','Järvinen','Korhonen','Laine','Mäkinen','Niemi','Ojala',
  'Peltonen','Qvist','Rantanen','Salminen','Toivonen','Uotila','Virtanen',
  'Wirtanen','Ylitalo'];
const LAST = ['Antti','Bruno','Carl','Daniel','Eero','Frans','Gösta','Heikki',
  'Ilkka','Jussi','Kalle','Lauri','Mikko','Niilo','Olli','Pekka','Risto',
  'Sami','Timo','Ville','Antero','Kari','Matti','Jari'];
for (let i = 1; i <= N; i++) {
  const id = uuid();
  const first = LAST[(i - 1) % LAST.length];     // given name
  const last = FIRST[(i - 1) % FIRST.length];    // surname
  db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, club, country)
              VALUES (?, ?, ?, ?, 'FIN')`).run(id, first, last, `Club${i % 4 + 1}`);
  db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
    first_name, first_name_initial, last_name, club, country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FIN')`)
    .run(eventId, id, String(i), i, first, first[0] + '.', last, `Club${i % 4 + 1}`);
}

console.log(`Seeded ${DB_FILE}`);
console.log(`  Rule: ${rule.rule_name} (${steps} steps)`);
if (rule.min_athletes != null || rule.max_athletes != null) {
  console.log(`  Rule declared range: ${rule.min_athletes ?? '?'}-${rule.max_athletes ?? '?'} athletes`);
}
console.log(`  Athletes seeded: ${N}`);
console.log(`\nStart the server against this database:`);
console.log(`  node server.js ${dbArg}`);
console.log(`Then open http://localhost:3000`);
