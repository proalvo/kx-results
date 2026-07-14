// lib/progression.js — progression rules: JSON import + start-list generation.
//
// Design principle (confirmed by the customer): "progression proposes, the
// Chief disposes." applyProgression() generates a start list once; after
// that every slot, athlete and rank is manually editable and the engine
// never overwrites manual edits unless regeneration is explicitly requested.
//
// DNS and DSQ athletes do NOT progress: their target slot is left EMPTY
// with a note, so the Chief of Scoring can fill it manually (national
// variants may e.g. promote the next-ranked athlete — that is a human call).

'use strict';
const { uuid } = require('./db');

const VALID_PHASES = ['TT', 'Q', 'RQ', 'QF', 'SF', 'F'];
const VALID_ORDER_BY = ['tt_time'];

/**
 * Import a progression rule from its JSON form (see /rules/*.json for
 * worked examples, and the README for the full format writeup):
 *
 *   {
 *     "rule_name": "...", "description": "...",
 *     "min_athletes": 12, "max_athletes": 16,
 *     "progression": [
 *       { "from": {"phase":"TT","group":0,"rank":1}, "to": {"phase":"QF","group":1,"slot":1} },
 *       ...
 *     ],
 *     "final_result": [
 *       { "base_rank": 1, "from": [ {"phase":"F","group":1,"rank":1} ] },
 *       { "base_rank": 5, "order_by": "tt_time",
 *         "from": [ {"phase":"SF","group":1,"rank":3}, {"phase":"SF","group":2,"rank":3} ] },
 *       ...
 *     ]
 *   }
 *
 * `progression` entries are heat-to-heat advancements; `final_result`
 * entries are pools that resolve directly to final classification ranks
 * starting at `base_rank` (a pool with more than one source MUST name an
 * `order_by` tie-break — currently only "tt_time" is implemented).
 * Internally these still become flat progression_rule_step rows (final_result
 * members become to_phase='RESULT', to_group=0, to_slot=base_rank), so
 * nothing downstream (applyProgression, compileOfficialResult) changes.
 */
function importRuleJson(db, rule) {
  if (!rule || typeof rule !== 'object') throw new Error('Rule must be a JSON object');
  if (!rule.rule_name || typeof rule.rule_name !== 'string') {
    throw new Error('rule_name is required and must be a string');
  }
  const minAthletes = rule.min_athletes ?? null;
  const maxAthletes = rule.max_athletes ?? null;
  if (minAthletes != null && typeof minAthletes !== 'number') throw new Error('min_athletes must be a number');
  if (maxAthletes != null && typeof maxAthletes !== 'number') throw new Error('max_athletes must be a number');
  if (minAthletes != null && maxAthletes != null && minAthletes > maxAthletes) {
    throw new Error(`min_athletes (${minAthletes}) cannot exceed max_athletes (${maxAthletes})`);
  }
  if (!Array.isArray(rule.progression)) throw new Error('progression must be an array');
  if (!Array.isArray(rule.final_result)) throw new Error('final_result must be an array');

  const checkRef = (obj, label, requireSlotOrRank) => {
    if (!obj || typeof obj !== 'object') throw new Error(`${label} must be an object`);
    if (!VALID_PHASES.includes(obj.phase)) {
      throw new Error(`${label}.phase must be one of ${VALID_PHASES.join(', ')}, got "${obj.phase}"`);
    }
    if (!Number.isInteger(obj.group) || obj.group < 0) throw new Error(`${label}.group must be a non-negative integer`);
    const key = requireSlotOrRank;
    if (!Number.isInteger(obj[key]) || obj[key] < 1) throw new Error(`${label}.${key} must be a positive integer`);
  };

  // Flatten into the same rows the engine already understands.
  const steps = [];   // {from_phase, from_group, from_rank, to_phase, to_group, to_slot}
  rule.progression.forEach((entry, i) => {
    const label = `progression[${i}]`;
    checkRef(entry.from, `${label}.from`, 'rank');
    if (!['Q', 'RQ', 'QF', 'SF', 'F'].includes(entry.to?.phase)) {
      throw new Error(`${label}.to.phase must be one of Q, RQ, QF, SF, F, got "${entry.to?.phase}"`);
    }
    checkRef(entry.to, `${label}.to`, 'slot');
    steps.push({
      from_phase: entry.from.phase, from_group: entry.from.group, from_rank: entry.from.rank,
      to_phase: entry.to.phase, to_group: entry.to.group, to_slot: entry.to.slot,
    });
  });
  rule.final_result.forEach((pool, i) => {
    const label = `final_result[${i}]`;
    if (!Number.isInteger(pool.base_rank) || pool.base_rank < 1) {
      throw new Error(`${label}.base_rank must be a positive integer`);
    }
    if (!Array.isArray(pool.from) || pool.from.length < 1) {
      throw new Error(`${label}.from must be a non-empty array`);
    }
    if (pool.from.length > 1) {
      if (!pool.order_by) throw new Error(`${label} has ${pool.from.length} sources — order_by is required to break ties`);
      if (!VALID_ORDER_BY.includes(pool.order_by)) {
        throw new Error(`${label}.order_by "${pool.order_by}" is not implemented (supported: ${VALID_ORDER_BY.join(', ')})`);
      }
    } else if (pool.order_by && !VALID_ORDER_BY.includes(pool.order_by)) {
      throw new Error(`${label}.order_by "${pool.order_by}" is not implemented (supported: ${VALID_ORDER_BY.join(', ')})`);
    }
    pool.from.forEach((member, j) => checkRef(member, `${label}.from[${j}]`, 'rank'));
    for (const member of pool.from) {
      steps.push({
        from_phase: member.phase, from_group: member.group, from_rank: member.rank,
        to_phase: 'RESULT', to_group: 0, to_slot: pool.base_rank,
      });
    }
  });

  const ruleId = uuid();
  const insRule = db.prepare(
    `INSERT INTO progression_rule (rule_id, rule_name, description, min_athletes, max_athletes)
     VALUES (?, ?, ?, ?, ?)`);
  const insStep = db.prepare(
    `INSERT INTO progression_rule_step
       (rule_id, from_phase, from_group, from_rank, to_phase, to_group, to_slot)
     VALUES (?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  try {
    insRule.run(ruleId, rule.rule_name, rule.description || null, minAthletes, maxAthletes);
    // UNIQUE constraints in the schema reject duplicate sources/targets
    // (RESULT pool lines exempt), so a malformed rule fails loudly here
    // instead of at the event.
    for (const s of steps) {
      insStep.run(ruleId, s.from_phase, s.from_group, s.from_rank, s.to_phase, s.to_group, s.to_slot);
    }
    db.exec('COMMIT');
    return { ruleId, steps: steps.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Generate the start lists that follow `fromPhase`, from saved ranks.
 * Refuses to touch a target phase that already has rows unless
 * opts.regenerate is true (protects manual edits).
 * @returns {{created:number, notes:string[]}}
 */
function applyProgression(db, eventId, fromPhase, opts = {}) {
  const ev = db.prepare('SELECT rule_id FROM event WHERE event_id = ?').get(eventId);
  if (!ev || !ev.rule_id) throw new Error('Event has no progression rule assigned');

  const steps = db.prepare(
    `SELECT * FROM progression_rule_step
      WHERE rule_id = ? AND from_phase = ?
      ORDER BY to_phase, to_group, to_slot`
  ).all(ev.rule_id, fromPhase);
  if (!steps.length) return { created: 0, notes: [`No rule steps from phase ${fromPhase}`] };

  const targetPhases = [...new Set(steps.map(s => s.to_phase).filter(p => p !== 'RESULT'))];
  const notes = [];

  db.exec('BEGIN');
  try {
    // regenerate=true wipes the target phases first (explicitly discards
    // manual edits). Otherwise progression is SLOT-LEVEL and idempotent:
    // it only fills empty slots and never touches existing rows — several
    // phases may feed the same target phase (e.g. TT seeds QF slots 1-3,
    // a qualification round fills slot 4), and manual edits are preserved.
    if (opts.regenerate) {
      for (const tp of targetPhases) {
        db.prepare(`DELETE FROM result WHERE event_id = ? AND phase = ?`).run(eventId, tp);
        notes.push(`Phase ${tp}: existing start list discarded (regenerate)`);
      }
    }
    const slotTaken = db.prepare(
      `SELECT athlete_id FROM result
        WHERE event_id = ? AND phase = ? AND group_no = ? AND slot_no = ?`);
    const inPhase = db.prepare(
      `SELECT 1 FROM result WHERE event_id = ? AND phase = ? AND athlete_id = ?`);

    // Guard against the most common workflow mistake: applying progression
    // from a phase whose heats exist but haven't been ranked yet (rank IS
    // NULL). Without this check the step below silently finds no matching
    // rank and produces "created: 0, notes: []" — indistinguishable from
    // "nothing to progress" and very confusing (e.g. it looks like the next
    // phase, such as RQ, is simply "not available").
    const unranked = db.prepare(
      `SELECT DISTINCT group_no FROM result
        WHERE event_id = ? AND phase = ? AND rank IS NULL
          AND status IS NULL`      // DNS/DSQ rows may legitimately lack a rank pre-ranking
    ).all(eventId, fromPhase);
    if (unranked.length) {
      throw new Error(
        `Phase ${fromPhase} has unranked heat(s): ${unranked.map(u => 'G' + u.group_no).join(', ')}. ` +
        `Enter the finish order and click "Auto-rank" for ${unranked.length > 1 ? 'each of these heats' : 'this heat'} ` +
        `before applying progression.`);
    }

    const srcByGroup = db.prepare(
      `SELECT athlete_id, status FROM result
        WHERE event_id = ? AND phase = ? AND group_no = ? AND rank = ?`);
    const srcWholePhase = db.prepare(
      `SELECT athlete_id, status FROM result
        WHERE event_id = ? AND phase = ? AND rank = ?`);
    const ins = db.prepare(
      `INSERT INTO result (result_id, event_id, athlete_id, phase, group_no, slot_no)
       VALUES (?, ?, ?, ?, ?, ?)`);

    let created = 0;
    for (const s of steps) {
      if (s.to_phase === 'RESULT') continue;
      const src = s.from_group === 0
        ? srcWholePhase.get(eventId, fromPhase, s.from_rank)
        : srcByGroup.get(eventId, fromPhase, s.from_group, s.from_rank);
      if (!src) continue;                       // rule line beyond entry count
      if (src.status === 'DNS' || src.status === 'DSQ') {
        notes.push(
          `${fromPhase} G${s.from_group} rank ${s.from_rank} is ${src.status} -> ` +
          `${s.to_phase} G${s.to_group} slot ${s.to_slot} left empty for manual edit`);
        continue;                               // DNS/DSQ do NOT progress
      }
      if (slotTaken.get(eventId, s.to_phase, s.to_group, s.to_slot)) {
        notes.push(`${s.to_phase} G${s.to_group} slot ${s.to_slot} already filled — ` +
                   `skipped (manual edit preserved)`);
        continue;
      }
      if (inPhase.get(eventId, s.to_phase, src.athlete_id)) {
        notes.push(`Athlete from ${fromPhase} G${s.from_group} rank ${s.from_rank} ` +
                   `already in phase ${s.to_phase} — skipped`);
        continue;
      }
      ins.run(uuid(), eventId, src.athlete_id, s.to_phase, s.to_group, s.to_slot);
      created++;
    }
    db.exec('COMMIT');
    return { created, notes };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Compile the OFFICIAL RESULT (final classification 1..N) from the rule's
 * RESULT lines. Pool semantics (confirmed requirement): athletes eliminated
 * at the same point share a pool (to_group = first rank of the pool,
 * to_slot = 0) and are ordered WITHIN the pool by Time Trial time only.
 * A pool of size 1 is a deterministic mapping (e.g. Final winner -> rank 1).
 * Recomputable at any time (derived data): existing RESULT rows are replaced.
 * @returns {{classified:number, unclassified:string[], notes:string[]}}
 */
function compileOfficialResult(db, eventId) {
  const ev = db.prepare('SELECT rule_id FROM event WHERE event_id = ?').get(eventId);
  if (!ev || !ev.rule_id) throw new Error('Event has no progression rule assigned');
  const steps = db.prepare(
    `SELECT * FROM progression_rule_step
      WHERE rule_id = ? AND to_phase = 'RESULT'
      ORDER BY to_slot, from_phase, from_group, from_rank`).all(ev.rule_id);
  if (!steps.length) throw new Error('Rule has no RESULT lines — cannot compile classification');

  const srcByGroup = db.prepare(
    `SELECT r.athlete_id, r.status, tt.time_ms AS tt
       FROM result r
       LEFT JOIN result tt ON tt.event_id = r.event_id
            AND tt.athlete_id = r.athlete_id AND tt.phase = 'TT'
      WHERE r.event_id = ? AND r.phase = ? AND r.group_no = ? AND r.rank = ?`);
  const srcWhole = db.prepare(
    `SELECT r.athlete_id, r.status, tt.time_ms AS tt
       FROM result r
       LEFT JOIN result tt ON tt.event_id = r.event_id
            AND tt.athlete_id = r.athlete_id AND tt.phase = 'TT'
      WHERE r.event_id = ? AND r.phase = ? AND r.rank = ?`);

  const pools = new Map();                       // base rank -> [{athlete_id, tt}]
  const notes = [];
  for (const s of steps) {
    const src = s.from_group === 0
      ? srcWhole.get(eventId, s.from_phase, s.from_rank)
      : srcByGroup.get(eventId, s.from_phase, s.from_group, s.from_rank);
    if (!src) {                                  // heat not run yet / fewer entrants
      notes.push(`No athlete at ${s.from_phase} G${s.from_group} rank ${s.from_rank} (skipped)`);
      continue;
    }
    if (!pools.has(s.to_slot)) pools.set(s.to_slot, []);
    pools.get(s.to_slot).push(src);
  }

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM result WHERE event_id = ? AND phase = 'RESULT'`).run(eventId);
    const ins = db.prepare(
      `INSERT INTO result (result_id, event_id, athlete_id, phase, group_no, slot_no, rank)
       VALUES (?, ?, ?, 'RESULT', 1, ?, ?)`);
    let classified = 0;
    for (const [base, members] of [...pools.entries()].sort((a, b) => a[0] - b[0])) {
      members.sort((a, b) =>
        (a.tt ?? Number.MAX_SAFE_INTEGER) - (b.tt ?? Number.MAX_SAFE_INTEGER));
      members.forEach((m, i) => {
        ins.run(uuid(), eventId, m.athlete_id, base + i, base + i);
        classified++;
      });
    }
    // linting: entrants with no final classification indicate rule dead ends
    const missing = db.prepare(
      `SELECT ea.bib, ea.last_name FROM event_athlete ea
        WHERE ea.event_id = ?
          AND ea.athlete_id NOT IN
              (SELECT athlete_id FROM result WHERE event_id = ? AND phase = 'RESULT')
        ORDER BY CAST(ea.bib AS INTEGER)`).all(eventId, eventId);
    db.exec('COMMIT');
    return { classified,
             unclassified: missing.map(m => `bib ${m.bib} ${m.last_name}`),
             notes };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * Check whether a rule's declared athlete range fits an actual entry count.
 * min_athletes === max_athletes means the rule is exact-count-only (no
 * tolerance); a range allows a shortfall down to min_athletes (the RQ/SF
 * pooling mechanism reports specific gaps for missing entrants in that case).
 * A rule with no min/max recorded (both null) always reports fits: true —
 * older or hand-imported rules aren't retroactively blocked.
 * @returns {{fits:boolean, reason:string|null}}
 */
function checkRuleFits(rule, athleteCount) {
  const { min_athletes: min, max_athletes: max } = rule;
  if (min == null && max == null) return { fits: true, reason: null };
  if (min != null && min === max && athleteCount !== min) {
    return { fits: false,
      reason: `Rule "${rule.rule_name}" requires exactly ${min} athletes (got ${athleteCount}).` };
  }
  if (min != null && athleteCount < min) {
    return { fits: false,
      reason: `Rule "${rule.rule_name}" requires at least ${min} athletes (got ${athleteCount}).` };
  }
  if (max != null && athleteCount > max) {
    return { fits: false,
      reason: `Rule "${rule.rule_name}" supports at most ${max} athletes (got ${athleteCount}).` };
  }
  return { fits: true, reason: null };
}

module.exports = { importRuleJson, applyProgression, compileOfficialResult, checkRuleFits };
