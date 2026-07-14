// scripts/upload-rules.js — import every rule in /rules into a database.
//
// Usage:
//   node scripts/upload-rules.js [dbfile]
//
// Reads every *.json file in the top-level rules/ directory (see that
// folder for the format and worked examples — same format the Rules page
// uploads) and imports each one. Safe to re-run: a rule that's already
// present (same rule_name) is reported and skipped rather than treated as
// a failure, so this can be run repeatedly as new rule files are added to
// the archive without re-importing everything from scratch.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../lib/db');
const { importRuleJson } = require('../lib/progression');

const DB_FILE = process.argv[2] ?? path.join(__dirname, '..', 'kx.db');
const RULES_DIR = path.join(__dirname, '..', 'rules');

if (!fs.existsSync(RULES_DIR)) {
  console.error(`No rules/ directory found at ${RULES_DIR}`);
  process.exit(1);
}
if (!fs.existsSync(DB_FILE)) {
  console.error(`${DB_FILE} does not exist. Seed a database first ` +
    `(e.g. node scripts/seed.js ${path.basename(DB_FILE)}) or point at an existing one.`);
  process.exit(1);
}

const db = open(DB_FILE);
const files = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.json')).sort();

if (!files.length) {
  console.log(`No .json files found in ${RULES_DIR}`);
  process.exit(0);
}

let imported = 0, skipped = 0, failed = 0;
for (const file of files) {
  const filePath = path.join(RULES_DIR, file);
  let rule;
  try {
    rule = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.log(`  FAILED  ${file}: not valid JSON (${e.message})`);
    failed++;
    continue;
  }
  try {
    const r = importRuleJson(db, rule);
    console.log(`  OK      ${file} -> "${rule.rule_name}" (${r.steps} steps)`);
    imported++;
  } catch (e) {
    if (/UNIQUE constraint failed: progression_rule\.rule_name/.test(e.message)) {
      console.log(`  SKIPPED ${file}: rule "${rule.rule_name}" already exists`);
      skipped++;
    } else {
      console.log(`  FAILED  ${file}: ${e.message}`);
      failed++;
    }
  }
}

console.log(`\n${imported} imported, ${skipped} skipped (already present), ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
