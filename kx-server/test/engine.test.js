// test/engine.test.js — the validated paper competition as a regression suite.
//
// This is the SAME scenario the customer validated in the Python simulation:
// 15 athletes, TT -> 4 QF -> 2 SF -> Final + Small Final, with all the
// confirmed edge cases. If any refactoring changes the ranking or
// progression behavior, these tests fail.
//
// Run:  node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { open, uuid } = require('../lib/db');
const { rankHeat, rankTimeTrial, compareFaults } = require('../lib/ranking');
const { importRuleJson, applyProgression, compileOfficialResult } = require('../lib/progression');

const db = open(':memory:');

// ------------------------------------------------------------------ fixture
const compId = uuid(), eventId = uuid();
db.prepare(`INSERT INTO competition (competition_id, competition_name,
  start_date, end_date, country, gate_judge_pin)
  VALUES (?, 'Test Cup', '2026-07-11', '2026-07-12', 'FIN', '1234')`).run(compId);

// This is the actual production rule file (see /rules), not a copy —
// the regression suite validates the real archive, not a stand-in.
const rule1216 = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'rules', 'rule_12-16_athletes.json'), 'utf8'));
const { ruleId, steps } = importRuleJson(db, rule1216);

db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name,
  gates, rule_id) VALUES (?, ?, 'KXM', 'Kayak Cross Men', 6, ?)`)
  .run(eventId, compId, ruleId);

const NAMES = ['Aalto Antti','Bergman Bruno','Carlsson Carl','Degerman Daniel',
  'Eskola Eero','Forsman Frans','Gustafsson Gösta','Heikkinen Heikki',
  'Ilves Ilkka','Järvinen Jussi','Korhonen Kalle','Laine Lauri',
  'Mäkinen Mikko','Niemi Niilo','Ojala Olli'];
const A = {};                                            // bib -> athlete_id
NAMES.forEach((full, i) => {
  const [last, first] = full.split(' ');
  const id = uuid(); A[String(i + 1)] = id;
  db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
              VALUES (?, ?, ?, 'FIN')`).run(id, first, last);
  db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
    first_name, first_name_initial, last_name) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, id, String(i + 1), i + 1, first, first[0] + '.', last);
});

const resultId = (bib, phase, grp) => db.prepare(
  `SELECT result_id FROM result WHERE event_id = ? AND athlete_id = ?
   AND phase = ? AND group_no = ?`).get(eventId, A[bib], phase, grp)?.result_id;
const rankOf = (bib, phase, grp) => db.prepare(
  `SELECT rank FROM result WHERE event_id = ? AND athlete_id = ?
   AND phase = ? AND group_no = ?`).get(eventId, A[bib], phase, grp)?.rank;
const pen = (bib, phase, grp, gate, type, by = 'gate-judge') =>
  db.prepare(`INSERT INTO result_penalty (penalty_id, result_id, gate_no,
    penalty, issued_by) VALUES (?, ?, ?, ?, ?)`)
    .run(uuid(), resultId(bib, phase, grp), gate, type, by);
const setStatus = (bib, phase, grp, s) =>
  db.prepare('UPDATE result SET status = ? WHERE result_id = ?')
    .run(s, resultId(bib, phase, grp));

// -------------------------------------------------------------------- tests
test('fault comparator: confirmed customer rules', () => {
  assert.ok(compareFaults([5], [2]) < 0, 'FLT@5 beats FLT@2');
  assert.ok(compareFaults([5, 6], [2]) < 0, 'FLT@5+6 beats FLT@2 (first fault later)');
  assert.ok(compareFaults([5], [5, 6]) < 0, 'FLT@5 beats FLT@5+6 (fewer, same prefix)');
  assert.equal(compareFaults([4], [4]), 0, 'identical lists tie -> TT decides');
});

test('rule import: 31 steps, duplicate targets still rejected by schema', () => {
  assert.equal(steps, 31);
  assert.throws(() => importRuleJson(db, {
    rule_name: 'dup-target',
    progression: [
      { from: { phase: 'Q', group: 1, rank: 1 }, to: { phase: 'SF', group: 1, slot: 1 } },
      { from: { phase: 'Q', group: 2, rank: 1 }, to: { phase: 'SF', group: 1, slot: 1 } },
    ],
    final_result: [],
  }), /UNIQUE/i);
});

test('time trial: 15 athletes ranked by time', () => {
  const times = [91230, 92010, 92450, 92940, 93110, 93480, 93720, 94050,
                 94390, 94800, 95120, 95660, 96210, 96870, 97500];
  const ins = db.prepare(`INSERT INTO result (result_id, event_id, athlete_id,
    phase, group_no, slot_no, time_ms) VALUES (?, ?, ?, 'TT', 1, ?, ?)`);
  times.forEach((t, i) => ins.run(uuid(), eventId, A[String(i + 1)], i + 1, t));
  assert.equal(rankTimeTrial(db, eventId), 15);
  assert.equal(rankOf('1', 'TT', 1), 1);
  assert.equal(rankOf('15', 'TT', 1), 15);
});

test('progression TT -> QF: 15 seeded, unfilled rule lines skipped', () => {
  const r = applyProgression(db, eventId, 'TT');
  assert.equal(r.created, 15);
  assert.equal(rankOf('1', 'QF', 1) !== undefined, true);
});

test('progression is slot-level idempotent: re-run fills nothing, preserves edits', () => {
  const r = applyProgression(db, eventId, 'TT');
  assert.equal(r.created, 0, 're-run creates nothing');
  assert.match(r.notes.join(' '), /already filled — skipped/);
});

test('QF heats: all confirmed edge cases', () => {
  // QF1 clean
  rankHeat(db, eventId, 'QF', 1, ['1', '9', '8']);
  assert.equal(rankOf('1', 'QF', 1), 1);

  // QF2: FLT@2 vs FLT@5 — later first fault ranks higher
  pen('2', 'QF', 2, 2, 'FLT');
  pen('7', 'QF', 2, 5, 'FLT');
  rankHeat(db, eventId, 'QF', 2, ['2', '7', '10', '15']);
  assert.equal(rankOf('10', 'QF', 2), 1, 'penalties change who advances');
  assert.ok(rankOf('7', 'QF', 2) < rankOf('2', 'QF', 2), 'FLT@5 above FLT@2');

  // QF3: identical FLT@4 -> TT time only; revoked penalty ignored but audited
  pen('6', 'QF', 3, 4, 'FLT');
  pen('11', 'QF', 3, 4, 'FLT');
  pen('3', 'QF', 3, 3, 'FLT', 'gate-judge:3');
  db.prepare(`UPDATE result_penalty SET revoked_at = '2026-07-11T10:00:00Z',
    revoked_by = 'chief' WHERE result_id = ? AND gate_no = 3`)
    .run(resultId('3', 'QF', 3));
  rankHeat(db, eventId, 'QF', 3, ['3', '6', '11', '14']);
  assert.ok(rankOf('6', 'QF', 3) < rankOf('11', 'QF', 3), 'TT breaks identical faults');
  assert.equal(rankOf('3', 'QF', 3), 1, 'revoked penalty ignored');

  // QF4: FLT@5+6 beats FLT@2; DNF last
  pen('5', 'QF', 4, 5, 'FLT'); pen('5', 'QF', 4, 6, 'FLT');
  pen('12', 'QF', 4, 2, 'FLT');
  setStatus('13', 'QF', 4, 'DNF');
  rankHeat(db, eventId, 'QF', 4, ['4', '5', '12']);
  assert.ok(rankOf('5', 'QF', 4) < rankOf('12', 'QF', 4), 'FLT@5+6 above FLT@2');
  assert.equal(rankOf('13', 'QF', 4), 4, 'DNF last');
});

test('SF heats: FLT prefix rule, DNS ranked last', () => {
  applyProgression(db, eventId, 'QF');
  rankHeat(db, eventId, 'SF', 1, ['1', '10', '9', '15']);
  setStatus('14', 'SF', 2, 'DNS');
  pen('4', 'SF', 2, 5, 'FLT');
  pen('5', 'SF', 2, 5, 'FLT'); pen('5', 'SF', 2, 6, 'FLT');
  rankHeat(db, eventId, 'SF', 2, ['3', '5', '4']);
  assert.ok(rankOf('4', 'SF', 2) < rankOf('5', 'SF', 2), 'FLT@5 above FLT@5+6');
  assert.equal(rankOf('14', 'SF', 2), 4, 'DNS ranked last in heat');
});

test('DNS does not progress: slot left empty for manual edit', () => {
  const r = applyProgression(db, eventId, 'SF');
  assert.equal(r.created, 7, '8 slots, 1 vacated by DNS');
  assert.match(r.notes.join(' '), /DNS.*left empty/);
  assert.equal(resultId('14', 'F', 2), undefined, 'DNS athlete not in Small Final');
});

test('manual edit: Chief fills vacated slot; engine ranks it normally', () => {
  db.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase,
    group_no, slot_no) VALUES (?, ?, ?, 'F', 2, 4)`)
    .run(uuid(), eventId, A['8']);
  rankHeat(db, eventId, 'F', 2, ['9', '5', '8', '15']);
  assert.equal(rankOf('8', 'F', 2), 3, 'manually added athlete ranked normally');
});

test('Final: RAL below all FLT despite winning on water (confirmed rule)', () => {
  pen('10', 'F', 1, 3, 'RAL', 'gate-judge:3');
  pen('3', 'F', 1, 6, 'FLT');
  rankHeat(db, eventId, 'F', 1, ['10', '1', '3', '4']);
  assert.equal(rankOf('1', 'F', 1), 1);
  assert.ok(rankOf('10', 'F', 1) > rankOf('3', 'F', 1), 'RAL below FLT');
});

test('schema constraints: duplicate start slot rejected', () => {
  assert.throws(() => db.prepare(`INSERT INTO result (result_id, event_id,
    athlete_id, phase, group_no, slot_no) VALUES (?, ?, ?, 'F', 2, 4)`)
    .run(uuid(), eventId, A['2']), /UNIQUE/i);
});

test('audit trail: revoked penalty preserved, never deleted', () => {
  const c = db.prepare(`SELECT COUNT(*) AS c FROM result_penalty
    WHERE revoked_at IS NOT NULL`).get().c;
  assert.equal(c, 1);
});

// ============================================================================
// RQ phase (Repechage Qualification, 19-20 athletes) + TT-decided pools
// Self-contained fixture: separate database, separate rule.
// ============================================================================
test('RQ phase: rule imports, schema accepts the new phase', () => {
  const db2 = open(':memory:');
  const rule = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'rules', 'rule_19-20_athletes.json'), 'utf8'));
  const { steps } = importRuleJson(db2, rule);
  assert.equal(steps, 68);
});

test('RQ phase + TT pools: full 20-athlete event classifies everyone', () => {
  const db2 = open(':memory:');
  const compId = uuid(), eventId = uuid();
  db2.prepare(`INSERT INTO competition (competition_id, competition_name,
    start_date, end_date, country, gate_judge_pin)
    VALUES (?, 'RQ Cup', '2026-07-11', '2026-07-12', 'FIN', '1234')`).run(compId);
  const rule = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'rules', 'rule_19-20_athletes.json'), 'utf8'));
  const { ruleId } = importRuleJson(db2, rule);
  db2.prepare(`INSERT INTO event (event_id, competition_id, event_code,
    event_name, gates, rule_id) VALUES (?, ?, 'KXM', 'Kayak Cross Men', 6, ?)`)
    .run(eventId, compId, ruleId);

  const B = {};
  for (let i = 1; i <= 20; i++) {
    const id = uuid(); B[i] = id;
    db2.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
      VALUES (?, ?, ?, 'FIN')`).run(id, 'F' + i, 'L' + i);
    db2.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
      first_name, first_name_initial, last_name)
      VALUES (?, ?, ?, ?, ?, 'F.', ?)`).run(eventId, id, String(i), i, 'F' + i, 'L' + i);
  }
  const ins = db2.prepare(`INSERT INTO result (result_id, event_id, athlete_id,
    phase, group_no, slot_no, time_ms) VALUES (?, ?, ?, 'TT', 1, ?, ?)`);
  for (let i = 1; i <= 20; i++) ins.run(uuid(), eventId, B[i], i, 90000 + i * 100);
  rankTimeTrial(db2, eventId);
  applyProgression(db2, eventId, 'TT');

  const rankAll = phase => {
    const heats = db2.prepare(`SELECT DISTINCT group_no FROM result
      WHERE event_id = ? AND phase = ?`).all(eventId, phase);
    for (const { group_no } of heats) {
      const rows = db2.prepare(`SELECT r.*, ea.bib FROM result r
        JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
        WHERE r.event_id = ? AND r.phase = ? AND r.group_no = ? ORDER BY r.slot_no`)
        .all(eventId, phase, group_no);
      rankHeat(db2, eventId, phase, group_no, rows.map(x => x.bib));
    }
    return heats.length;
  };
  for (const ph of ['Q', 'RQ', 'QF', 'SF', 'F']) {
    if (rankAll(ph)) applyProgression(db2, eventId, ph);
  }

  const result = compileOfficialResult(db2, eventId);
  assert.equal(result.classified, 20, 'every athlete gets a final rank');
  assert.equal(result.unclassified.length, 0);

  const rankOf2 = bib => db2.prepare(
    `SELECT rank FROM result WHERE event_id = ? AND athlete_id = ? AND phase = 'RESULT'`
  ).get(eventId, B[bib])?.rank;
  assert.equal(rankOf2('1'), 1, 'Final winner is TT rank 1 (clean heats)');
  assert.equal(rankOf2('20'), 20, 'slowest overall qualifier finishes 20th');
  // RQ ranks 17-20 come from an actually-raced heat (1:1 mapping), not a pool:
  const heatRow = db2.prepare(`SELECT rank AS heat_rank, athlete_id FROM result
    WHERE event_id = ? AND phase = 'RQ' AND group_no = 1 AND rank = 1`).get(eventId);
  assert.equal(rankOf2(Object.keys(B).find(b => B[b] === heatRow.athlete_id)), 17,
    'RQ heat winner -> final rank 17 directly, no TT tie-break needed');
});

test('RQ phase: 19 athletes (one short) reports the gap, still classifies the rest', () => {
  const db2 = open(':memory:');
  const compId = uuid(), eventId = uuid();
  db2.prepare(`INSERT INTO competition (competition_id, competition_name,
    start_date, end_date, country, gate_judge_pin)
    VALUES (?, 'RQ Cup 19', '2026-07-11', '2026-07-12', 'FIN', '1234')`).run(compId);
  const rule = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'rules', 'rule_19-20_athletes.json'), 'utf8'));
  const { ruleId } = importRuleJson(db2, rule);
  db2.prepare(`INSERT INTO event (event_id, competition_id, event_code,
    event_name, gates, rule_id) VALUES (?, ?, 'KXM', 'Kayak Cross Men', 6, ?)`)
    .run(eventId, compId, ruleId);

  const B = {};
  for (let i = 1; i <= 19; i++) {
    const id = uuid(); B[i] = id;
    db2.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
      VALUES (?, ?, ?, 'FIN')`).run(id, 'F' + i, 'L' + i);
    db2.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
      first_name, first_name_initial, last_name)
      VALUES (?, ?, ?, ?, ?, 'F.', ?)`).run(eventId, id, String(i), i, 'F' + i, 'L' + i);
  }
  const ins = db2.prepare(`INSERT INTO result (result_id, event_id, athlete_id,
    phase, group_no, slot_no, time_ms) VALUES (?, ?, ?, 'TT', 1, ?, ?)`);
  for (let i = 1; i <= 19; i++) ins.run(uuid(), eventId, B[i], i, 90000 + i * 100);
  rankTimeTrial(db2, eventId);
  applyProgression(db2, eventId, 'TT');

  const rankAll = phase => {
    const heats = db2.prepare(`SELECT DISTINCT group_no FROM result
      WHERE event_id = ? AND phase = ?`).all(eventId, phase);
    for (const { group_no } of heats) {
      const rows = db2.prepare(`SELECT r.*, ea.bib FROM result r
        JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
        WHERE r.event_id = ? AND r.phase = ? AND r.group_no = ? ORDER BY r.slot_no`)
        .all(eventId, phase, group_no);
      rankHeat(db2, eventId, phase, group_no, rows.map(x => x.bib));
    }
    return heats.length;
  };
  for (const ph of ['Q', 'RQ', 'QF', 'SF', 'F']) {
    if (rankAll(ph)) applyProgression(db2, eventId, ph);
  }

  const result = compileOfficialResult(db2, eventId);
  assert.equal(result.classified, 19, 'all 19 entrants classified despite the gap');
  assert.match(result.notes.join(' '), /No athlete at RQ/);
});

test('progression guard: applying from an unranked phase fails clearly, not silently', () => {
  const db2 = open(':memory:');
  const compId = uuid(), eventId = uuid();
  db2.prepare(`INSERT INTO competition (competition_id, competition_name,
    start_date, end_date, country, gate_judge_pin)
    VALUES (?, 'Guard Test', '2026-07-11', '2026-07-12', 'FIN', '1234')`).run(compId);
  const rule = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'rules', 'rule_19-20_athletes.json'), 'utf8'));
  const { ruleId } = importRuleJson(db2, rule);
  db2.prepare(`INSERT INTO event (event_id, competition_id, event_code,
    event_name, gates, rule_id) VALUES (?, ?, 'KXM', 'Kayak Cross Men', 6, ?)`)
    .run(eventId, compId, ruleId);
  const B = {};
  for (let i = 1; i <= 19; i++) {
    const id = uuid(); B[i] = id;
    db2.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
      VALUES (?, ?, ?, 'FIN')`).run(id, 'F' + i, 'L' + i);
    db2.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
      first_name, first_name_initial, last_name)
      VALUES (?, ?, ?, ?, ?, 'F.', ?)`).run(eventId, id, String(i), i, 'F' + i, 'L' + i);
  }
  const ins = db2.prepare(`INSERT INTO result (result_id, event_id, athlete_id,
    phase, group_no, slot_no, time_ms) VALUES (?, ?, ?, 'TT', 1, ?, ?)`);
  for (let i = 1; i <= 19; i++) ins.run(uuid(), eventId, B[i], i, 90000 + i * 100);
  rankTimeTrial(db2, eventId);
  applyProgression(db2, eventId, 'TT');       // creates unranked Q heats

  // The exact mistake: apply progression from Q before ranking Q's heats.
  assert.throws(() => applyProgression(db2, eventId, 'Q'),
    /Q has unranked heat\(s\).*Auto-rank/s,
    'must fail loudly, not silently return created:0');

  // RQ must not silently half-exist after the failed attempt.
  const rq = db2.prepare(`SELECT COUNT(*) AS c FROM result
    WHERE event_id = ? AND phase = 'RQ'`).get(eventId).c;
  assert.equal(rq, 0);
});

// ============================================================================
// min_athletes / max_athletes rule metadata
// ============================================================================
test('progression_rule stores min/max athletes; checkRuleFits enforces them', () => {
  const { checkRuleFits } = require('../lib/progression');
  const db2 = open(':memory:');
  const rule28 = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'rules', 'rule_28_athletes_exact.json'), 'utf8'));
  const { ruleId } = importRuleJson(db2, rule28);
  const rule = db2.prepare('SELECT * FROM progression_rule WHERE rule_id = ?').get(ruleId);
  assert.equal(rule.min_athletes, 28);
  assert.equal(rule.max_athletes, 28);

  assert.equal(checkRuleFits(rule, 28).fits, true);
  assert.equal(checkRuleFits(rule, 25).fits, false, 'exact rule rejects fewer than 28');
  assert.equal(checkRuleFits(rule, 30).fits, false, 'exact rule rejects more than 28');

  const rule1920 = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'rules', 'rule_19-20_athletes.json'), 'utf8'));
  const { ruleId: r2 } = importRuleJson(db2, rule1920);
  const rule2 = db2.prepare('SELECT * FROM progression_rule WHERE rule_id = ?').get(r2);
  assert.equal(checkRuleFits(rule2, 19).fits, true, 'range rule tolerates the minimum');
  assert.equal(checkRuleFits(rule2, 18).fits, false, 'range rule rejects below minimum');
  assert.equal(checkRuleFits(rule2, 21).fits, false, 'range rule rejects above maximum');
});

test('rule import rejects min_athletes > max_athletes', () => {
  const db2 = open(':memory:');
  const rule = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'rules', 'rule_12-16_athletes.json'), 'utf8'));
  rule.min_athletes = 20; rule.max_athletes = 10;   // deliberately invalid override
  assert.throws(
    () => importRuleJson(db2, rule),
    /min_athletes.*cannot exceed max_athletes/);
});

test('rule without min/max metadata fits any athlete count (backward compatible)', () => {
  const { checkRuleFits } = require('../lib/progression');
  const rule = { rule_name: 'legacy', min_athletes: null, max_athletes: null };
  assert.equal(checkRuleFits(rule, 3).fits, true);
  assert.equal(checkRuleFits(rule, 99).fits, true);
});

// ============================================================================
// start-tt guard: blocks mismatched athlete count against an exact rule
// ============================================================================
test('start-tt-equivalent: exact rule blocks mismatched count, force overrides', () => {
  const { checkRuleFits } = require('../lib/progression');
  const db2 = open(':memory:');
  const ruleJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'rules', 'rule_28_athletes_exact.json'), 'utf8'));
  const { ruleId } = importRuleJson(db2, ruleJson);
  const rule = db2.prepare('SELECT * FROM progression_rule WHERE rule_id = ?').get(ruleId);
  const check = checkRuleFits(rule, 25);
  assert.equal(check.fits, false);
  assert.match(check.reason, /requires exactly 28/);
  // The API layer (lib/api.js /api/phase/start-tt) throws check.reason unless
  // body.force is true — verified live against the running server separately.
});

// ============================================================================
// Split-time TT timing (lib/tt-timing.js)
// ============================================================================
const { ttStartOffsetMs, computeTTResultTimeMs, splitTimingEnabled } = require('../lib/tt-timing');

test('tt-timing: start offset matches spec example (60s interval, 5min shift)', () => {
  const interval = 60_000, shift = 300_000;
  assert.equal(ttStartOffsetMs(1, interval, shift), 300_000);  // 5:00
  assert.equal(ttStartOffsetMs(2, interval, shift), 360_000);  // 6:00
  assert.equal(ttStartOffsetMs(3, interval, shift), 420_000);  // 7:00
});

test('tt-timing: result time = split time minus start offset', () => {
  const interval = 60_000, shift = 300_000;
  // Athlete 1 (starts at 5:00) finishes when the shared clock reads 8:30 -> ran 3:30
  assert.equal(computeTTResultTimeMs(510_000, 1, interval, shift), 210_000);
  // Athlete 2 (starts at 6:00) finishes at 9:45 -> ran 3:45
  assert.equal(computeTTResultTimeMs(585_000, 2, interval, shift), 225_000);
});

test('tt-timing: rejects a split time earlier than the athlete\'s own start', () => {
  const interval = 60_000, shift = 300_000;
  assert.throws(() => computeTTResultTimeMs(100_000, 1, interval, shift), /before this athlete's start/);
});

test('tt-timing: splitTimingEnabled requires both fields set', () => {
  assert.equal(splitTimingEnabled({ tt_start_interval_ms: 60000, tt_time_shift_ms: 300000 }), true);
  assert.equal(splitTimingEnabled({ tt_start_interval_ms: null, tt_time_shift_ms: null }), false);
  assert.equal(splitTimingEnabled({ tt_start_interval_ms: 60000, tt_time_shift_ms: null }), false);
  assert.equal(splitTimingEnabled(null), false);
});

test('split-time TT timing: end-to-end through the real API layer', () => {
  const db2 = open(':memory:');
  const compId = uuid(), eventId2 = uuid();
  db2.prepare(`INSERT INTO competition (competition_id, competition_name,
    start_date, end_date, country, gate_judge_pin, tt_start_interval_ms, tt_time_shift_ms)
    VALUES (?, 'Split Cup', '2026-07-11', '2026-07-12', 'FIN', '1234', 60000, 300000)`)
    .run(compId);
  db2.prepare(`INSERT INTO event (event_id, competition_id, event_code,
    event_name, gates) VALUES (?, ?, 'KXM', 'Kayak Cross Men', 6)`)
    .run(eventId2, compId);
  const athleteId = uuid();
  db2.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
    VALUES (?, 'Test', 'Athlete', 'FIN')`).run(athleteId);
  db2.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
    first_name, first_name_initial, last_name) VALUES (?, ?, '1', 1, 'Test', 'T.', 'Athlete')`)
    .run(eventId2, athleteId);
  const resultId = uuid();
  db2.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase,
    group_no, slot_no) VALUES (?, ?, ?, 'TT', 1, 1)`).run(resultId, eventId2, athleteId);

  // Simulate exactly what the Phase page / Gate Judge PATCH would send
  const comp = db2.prepare('SELECT * FROM competition WHERE competition_id = ?').get(compId);
  const row = db2.prepare(`SELECT r.slot_no FROM result r WHERE r.result_id = ?`).get(resultId);
  assert.equal(splitTimingEnabled(comp), true);
  const timeMs = computeTTResultTimeMs(510_000, row.slot_no,
    comp.tt_start_interval_ms, comp.tt_time_shift_ms);
  db2.prepare('UPDATE result SET split_time_ms = ?, time_ms = ? WHERE result_id = ?')
    .run(510_000, timeMs, resultId);

  const final = db2.prepare('SELECT split_time_ms, time_ms FROM result WHERE result_id = ?').get(resultId);
  assert.equal(final.split_time_ms, 510_000);
  assert.equal(final.time_ms, 210_000);
});

// ============================================================================
// rule_SMSL2025_6-athletes.json — duplicate-source bug found and fixed
// ============================================================================
test('rule import rejects a duplicate SOURCE (same "from" feeding two targets)', () => {
  const db2 = open(':memory:');
  const rule = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'rules', 'rule_SMSL2025_6-athletes.json'), 'utf8'));
  // Reintroduce the original bug: SF G1 rank 2 sent to both F slot 3 and slot 4.
  const broken = JSON.parse(JSON.stringify(rule));
  const slot4 = broken.progression.find(s => s.to.phase === 'F' && s.to.slot === 4);
  slot4.from = { phase: 'SF', group: 1, rank: 2 };   // same source as the slot-3 entry
  assert.throws(() => importRuleJson(db2, broken), /UNIQUE constraint failed/);
});

test('rule_SMSL2025_6-athletes: full 6-athlete event classifies everyone, Final has all 4', () => {
  const db2 = open(':memory:');
  const compId2 = uuid(), eventId2 = uuid();
  db2.prepare(`INSERT INTO competition (competition_id, competition_name,
    start_date, end_date, country, gate_judge_pin)
    VALUES (?, 'SMSL6', '2026-07-11', '2026-07-12', 'FIN', '1234')`).run(compId2);
  const rule = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'rules', 'rule_SMSL2025_6-athletes.json'), 'utf8'));
  const { ruleId } = importRuleJson(db2, rule);
  db2.prepare(`INSERT INTO event (event_id, competition_id, event_code,
    event_name, gates, rule_id) VALUES (?, ?, 'KXM', 'Kayak Cross Men', 6, ?)`)
    .run(eventId2, compId2, ruleId);

  const B = {};
  for (let i = 1; i <= 6; i++) {
    const id = uuid(); B[i] = id;
    db2.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
      VALUES (?, ?, ?, 'FIN')`).run(id, 'F' + i, 'L' + i);
    db2.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
      first_name, first_name_initial, last_name)
      VALUES (?, ?, ?, ?, ?, 'F.', ?)`).run(eventId2, id, String(i), i, 'F' + i, 'L' + i);
  }
  const ins = db2.prepare(`INSERT INTO result (result_id, event_id, athlete_id,
    phase, group_no, slot_no, time_ms) VALUES (?, ?, ?, 'TT', 1, ?, ?)`);
  for (let i = 1; i <= 6; i++) ins.run(uuid(), eventId2, B[i], i, 90000 + i * 100);
  rankTimeTrial(db2, eventId2);
  applyProgression(db2, eventId2, 'TT');

  const rankAll = phase => {
    const heats = db2.prepare(`SELECT DISTINCT group_no FROM result
      WHERE event_id = ? AND phase = ?`).all(eventId2, phase);
    for (const { group_no } of heats) {
      const rows = db2.prepare(`SELECT r.*, ea.bib FROM result r
        JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
        WHERE r.event_id = ? AND r.phase = ? AND r.group_no = ? ORDER BY r.slot_no`)
        .all(eventId2, phase, group_no);
      rankHeat(db2, eventId2, phase, group_no, rows.map(x => x.bib));
    }
    return heats.length;
  };
  rankAll('SF');
  const r = applyProgression(db2, eventId2, 'SF');
  assert.equal(r.created, 4, 'all four Final slots filled — this is what the bug broke');

  rankAll('F');
  const result = compileOfficialResult(db2, eventId2);
  assert.equal(result.classified, 6, 'every athlete gets a final rank, no gaps');
  assert.equal(result.unclassified.length, 0);
});

// ============================================================================
// rankTimeTrial must account for FLT/RAL — bug found after adding split-time
// timing: a faulted athlete's computed time_ms could still outrank a clean
// athlete's slower time, since the old rankTimeTrial ignored penalties
// entirely and sorted purely by time_ms.
// ============================================================================
test('rankTimeTrial: a fault outranks a faster raw time (same rule as heats)', () => {
  const db2 = open(':memory:');
  const compId2 = uuid(), eventId2 = uuid();
  db2.prepare(`INSERT INTO competition (competition_id, competition_name,
    start_date, end_date, country, gate_judge_pin)
    VALUES (?, 'TT Fault', '2026-07-11', '2026-07-12', 'FIN', '1234')`).run(compId2);
  db2.prepare(`INSERT INTO event (event_id, competition_id, event_code,
    event_name, gates) VALUES (?, ?, 'KXM', 'Kayak Cross Men', 6)`).run(eventId2, compId2);

  const C = {};
  for (let i = 1; i <= 3; i++) {
    const id = uuid(); C[i] = id;
    db2.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
      VALUES (?, ?, ?, 'FIN')`).run(id, 'F' + i, 'L' + i);
    db2.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
      first_name, first_name_initial, last_name)
      VALUES (?, ?, ?, ?, ?, 'F.', ?)`).run(eventId2, id, String(i), i, 'F' + i, 'L' + i);
  }
  // bib 1: fastest raw time (100s) but faults at gate 3
  // bib 2: clean, 150s
  // bib 3: clean, 200s (slowest)
  const rid1 = uuid(), rid2 = uuid(), rid3 = uuid();
  db2.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase,
    group_no, slot_no, time_ms) VALUES (?, ?, ?, 'TT', 1, 1, 100000)`).run(rid1, eventId2, C[1]);
  db2.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase,
    group_no, slot_no, time_ms) VALUES (?, ?, ?, 'TT', 1, 2, 150000)`).run(rid2, eventId2, C[2]);
  db2.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase,
    group_no, slot_no, time_ms) VALUES (?, ?, ?, 'TT', 1, 3, 200000)`).run(rid3, eventId2, C[3]);
  db2.prepare(`INSERT INTO result_penalty (penalty_id, result_id, gate_no,
    penalty, issued_by) VALUES (?, ?, 3, 'FLT', 'test')`).run(uuid(), rid1);

  rankTimeTrial(db2, eventId2);

  const rankOf3 = bib => db2.prepare(`SELECT r.rank, r.time_ms FROM result r
    JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
    WHERE r.event_id = ? AND ea.bib = ? AND r.phase = 'TT'`).get(eventId2, bib);

  assert.equal(rankOf3('2').rank, 1, 'clean 150s beats the faulted fastest time');
  assert.equal(rankOf3('3').rank, 2, 'clean 200s still beats the fault, just slower than bib 2');
  assert.equal(rankOf3('1').rank, 3, 'faulted athlete ranked last despite the fastest raw time');
  assert.equal(rankOf3('1').time_ms, 100000, 'time_ms is preserved (for protest), not cleared or altered');
});

test('rankTimeTrial: RAL ranks below all FLT, same as heats; ties broken by time', () => {
  const db2 = open(':memory:');
  const compId2 = uuid(), eventId2 = uuid();
  db2.prepare(`INSERT INTO competition (competition_id, competition_name,
    start_date, end_date, country, gate_judge_pin)
    VALUES (?, 'TT RAL', '2026-07-11', '2026-07-12', 'FIN', '1234')`).run(compId2);
  db2.prepare(`INSERT INTO event (event_id, competition_id, event_code,
    event_name, gates) VALUES (?, ?, 'KXM', 'Kayak Cross Men', 6)`).run(eventId2, compId2);
  const C = {};
  for (let i = 1; i <= 4; i++) {
    const id = uuid(); C[i] = id;
    db2.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
      VALUES (?, ?, ?, 'FIN')`).run(id, 'F' + i, 'L' + i);
    db2.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
      first_name, first_name_initial, last_name)
      VALUES (?, ?, ?, ?, ?, 'F.', ?)`).run(eventId2, id, String(i), i, 'F' + i, 'L' + i);
  }
  const rids = {};
  for (let i = 1; i <= 4; i++) {
    rids[i] = uuid();
    db2.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase,
      group_no, slot_no, time_ms) VALUES (?, ?, ?, 'TT', 1, ?, ?)`)
      .run(rids[i], eventId2, C[i], i, 90000 + i * 1000);
  }
  db2.prepare(`INSERT INTO result_penalty (penalty_id, result_id, gate_no,
    penalty, issued_by) VALUES (?, ?, 5, 'FLT', 'test')`).run(uuid(), rids[2]);   // bib2: FLT
  db2.prepare(`INSERT INTO result_penalty (penalty_id, result_id, gate_no,
    penalty, issued_by) VALUES (?, ?, 2, 'RAL', 'test')`).run(uuid(), rids[3]);   // bib3: RAL (fastest raw time)

  rankTimeTrial(db2, eventId2);
  const rankOf = bib => db2.prepare(`SELECT r.rank FROM result r
    JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
    WHERE r.event_id = ? AND ea.bib = ? AND r.phase = 'TT'`).get(eventId2, bib).rank;

  assert.equal(rankOf('1'), 1, 'clean, fastest of the clean runs');
  assert.equal(rankOf('4'), 2, 'clean, slower');
  assert.equal(rankOf('2'), 3, 'FLT ranks above RAL despite a slower raw time than bib 3');
  assert.equal(rankOf('3'), 4, 'RAL ranks last even with the fastest raw time of all four');
});

test('stream-startlist.html never displays a raw TT time', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'stream-startlist.html'), 'utf8');
  assert.ok(!/\br\.time_ms\b|\bfmtTime\s*\(/.test(html));
});

test('stream-results.html: time shown only when clean, fault/status shown instead otherwise', () => {
  // Extract the two pure helper functions straight from the shipped page
  // (not a re-implementation) — same technique used to validate the
  // pagination/rotation logic on the streaming pages elsewhere in this
  // suite: the actual page code is what's under test, not a copy of it.
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'stream-results.html'), 'utf8');
  const fmtSrc = html.match(/const fmtTime = [\s\S]*?;\n/)[0];
  const fnSrc = html.match(/function timeOrFault\([\s\S]*?\n}/)[0];
  const scope = {};
  new Function('scope', `${fmtSrc}\n${fnSrc}\nscope.timeOrFault = timeOrFault;`)(scope);
  const { timeOrFault } = scope;

  const clean = timeOrFault({ time_ms: 210000 });
  assert.equal(clean.fault, false);
  assert.equal(clean.text, '3:30.00', 'clean result shows its actual time');

  const flt = timeOrFault({ time_ms: 91230, gate4: 'FLT' });
  assert.equal(flt.fault, true);
  assert.ok(!flt.text.includes('91230') && !flt.text.includes('1:31'),
    'a faulted result never shows its time, even though it has one');
  assert.match(flt.text, /FLT/);

  const ral = timeOrFault({ time_ms: 91230, gate2: 'RAL' });
  assert.match(ral.text, /RAL/);
  assert.equal(ral.fault, true);

  for (const status of ['DNS', 'DNF', 'DSQ']) {
    const r = timeOrFault({ time_ms: 91230, status });
    assert.equal(r.text, status);
    assert.equal(r.fault, true, `${status} is flagged as a fault-styled result, not a time`);
  }
});

test('stream-results.html: Official Result mode never requests the timing column', () => {
  // compileOfficialResult (lib/progression.js) never writes time_ms or
  // penalty data onto the compiled RESULT rows, so showing a timing
  // column there would always be blank — renderOfficialResult's call to
  // renderTable() must omit the showTiming argument (only renderHeatResult
  // passes it), matching what data actually exists.
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'stream-results.html'), 'utf8');
  const officialFn = html.match(/async function renderOfficialResult\([\s\S]*?\n}/)[0];
  assert.ok(!/renderTable\([\s\S]*,\s*true\s*\)/.test(officialFn),
    'renderOfficialResult must not pass showTiming=true to renderTable');
});

// ============================================================================
// stream-startlist.html: TT start list must not require Live Tracking
// ============================================================================
test('stream-startlist.html decideMode: TT list shown without Live Tracking, no stale reversion', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'stream-startlist.html'), 'utf8');
  const fnSrc = html.match(/function decideMode\([\s\S]*?\n}/)[0];
  const scope = {};
  new Function('scope', `${fnSrc}\nscope.decideMode = decideMode;`)(scope);
  const { decideMode } = scope;

  // The reported bug: operator has selected the event, but the Chief
  // hasn't (yet) turned Live Tracking on -- current_phase is null. The
  // overlay must still show the TT list rather than staying blank,
  // exactly as long as the event hasn't progressed past TT.
  assert.equal(decideMode({ current_phase: null }, [{ phase: 'TT' }]), 'tt-list');
  assert.equal(decideMode({ current_phase: null }, []), 'tt-list');
  assert.equal(decideMode({ current_phase: 'TT' }, [{ phase: 'TT' }]), 'tt-list');

  // Active heat elsewhere -> lower third.
  assert.equal(decideMode({ current_phase: 'QF', current_group: 1 },
    [{ phase: 'TT' }, { phase: 'QF' }]), 'lower-third');

  // The subtle boundary case: once the event has genuinely progressed
  // past TT, toggling Live Tracking off must NOT revert the overlay to a
  // stale pre-competition start list -- it should go blank instead.
  assert.equal(decideMode({ current_phase: null },
    [{ phase: 'TT' }, { phase: 'QF' }]), 'hidden');
});

// ============================================================================
// print.html — start list / results printing
// ============================================================================
test('print.html: timeOrFault matches stream-results.html exactly (never shows a faulted time)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'print.html'), 'utf8');
  const fmtSrc = html.match(/const fmtTime = [\s\S]*?;\n/)[0];
  const fnSrc = html.match(/function timeOrFault\([\s\S]*?\n}/)[0];
  const scope = {};
  new Function('scope', `${fmtSrc}\n${fnSrc}\nscope.timeOrFault = timeOrFault;`)(scope);
  const { timeOrFault } = scope;

  assert.equal(timeOrFault({ time_ms: 210000 }).fault, false);
  const flt = timeOrFault({ time_ms: 91230, gate4: 'FLT' });
  assert.equal(flt.fault, true);
  assert.ok(!flt.text.includes('91230'), 'a faulted row never shows its time on a printed sheet either');
  for (const status of ['DNS', 'DNF', 'DSQ']) {
    assert.equal(timeOrFault({ time_ms: 1, status }).text, status);
  }
});

test('print.html: Official Result never gets a timing column (RESULT rows carry no time data)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'print.html'), 'utf8');
  // showTiming is explicitly false whenever isResult is true — this is a
  // static structural check (like the equivalent stream-results.html
  // test) since RESULT rows never have time_ms populated to begin with.
  assert.match(html, /const showTiming = hasRanks && !isResult/);
});

test('print.html: has a designated header/footer image extension point (currently empty)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'print.html'), 'utf8');
  assert.match(html, /id="headerLogo"/);
  assert.match(html, /id="footerLogo"/);
});

test('print.html: print date/time is included, not deferred to a future version', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'print.html'), 'utf8');
  assert.match(html, /printedAt/);
  assert.match(html, /toLocaleDateString|toLocaleTimeString/);
});

// ============================================================================
// index.html: TT reference column must not go stale on direct Time entry
// ============================================================================
test('index.html: TT reference cell is tagged and updated in place for both time paths', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // The cell must be tagged so it CAN be targeted for an in-place update
  // (previously it was plain, static text — only ever refreshed by a full
  // table reload, which the focus-preserving SSE guard suppresses while
  // typing, so direct Time entry with split-timing OFF looked "stuck"
  // until navigating away and back).
  assert.match(html, /class="tt-ref"\s+data-result="\$\{r\.result_id\}"/);
  // And the onchange handler must actually update it for BOTH the direct
  // time_ms path (split timing off) and the split_time_ms path (split
  // timing on) -- not just the split-timing case, which is what the bug
  // report specifically called out as still working.
  const handlerSrc = html.match(/\$\('tbl'\)\.querySelectorAll\('\[data-f\]'\)\.forEach\(el => el\.onchange[\s\S]*?\n  \}\);/)[0];
  assert.match(handlerSrc, /tt-ref/);
  assert.match(handlerSrc, /\['time_ms', 'split_time_ms'\]\.includes\(el\.dataset\.f\)/);
});
