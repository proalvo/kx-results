// lib/ranking.js — heat and Time Trial ranking engine for Kayak Cross.
//
// Direct port of the Python logic validated in the paper-competition
// simulation. The rules implemented here were confirmed by the customer:
//
//   Category order within a heat (and, per the same rule, within the
//   Time Trial — a TT run with a fault is still a fault; time_ms alone
//   must never outrank a clean run, see rankTimeTrial below):
//     1. Clean finishers        -> by finish order (line crossing);
//                                  for TT specifically, "finish order" IS
//                                  time_ms — there's no separate crossing
//                                  order to reference.
//     2. FLT athletes           -> by fault comparison (below)
//     3. RAL athletes           -> below ALL FLT athletes; ties by TT time
//     4. DNF                    -> by TT time
//     5. DNS                    -> by TT time
//     6. DSQ                    -> ranked last
//
//   FLT comparison ("athlete who progresses furthest through the course
//   before their first fault ranks higher; multiple faults cumulate,
//   taking into account the gate where the fault occurred"):
//     Faults = ordered list of gate numbers (ascending).
//     Compare position by position; at the first difference the HIGHER
//     gate wins. Equal prefix but extra later faults -> FEWER faults wins.
//     Identical fault lists -> Time Trial time decides (TT time ONLY).

'use strict';

const CAT = { CLEAN: 0, FLT: 1, RAL: 2, DNF: 3, DNS: 4, DSQ: 5 };
const BIG = Number.MAX_SAFE_INTEGER;

/** Compare two fault-gate lists (ascending). Negative -> a ranks higher. */
function compareFaults(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return b[i] - a[i];   // higher gate at first diff wins
  }
  return a.length - b.length;                // equal prefix: fewer faults wins
}

function ttTime(db, eventId, athleteId) {
  const row = db.prepare(
    `SELECT time_ms FROM result
     WHERE event_id = ? AND athlete_id = ? AND phase = 'TT'`
  ).get(eventId, athleteId);
  return row && row.time_ms != null ? row.time_ms : BIG;
}

function activePenalties(db, resultId, type) {
  return db.prepare(
    `SELECT gate_no FROM result_penalty
     WHERE result_id = ? AND penalty = ? AND revoked_at IS NULL
     ORDER BY gate_no`
  ).all(resultId, type).map(r => r.gate_no);
}

/**
 * Rank one heat and write `rank` into the result rows.
 * @param {object} db
 * @param {string} eventId
 * @param {string} phase       'Q' | 'QF' | 'SF' | 'F'
 * @param {number} groupNo
 * @param {string[]} finishOrder  bibs in order of crossing the finish line
 *                                (only clean finishers need to appear)
 * @returns {Array} ranked rows [{result_id, athlete_id, bib, rank, ...}]
 */
function rankHeat(db, eventId, phase, groupNo, finishOrder) {
  const rows = db.prepare(
    `SELECT r.result_id, r.athlete_id, r.status, ea.bib
       FROM result r
       JOIN event_athlete ea
         ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
      WHERE r.event_id = ? AND r.phase = ? AND r.group_no = ?`
  ).all(eventId, phase, groupNo);

  const entries = rows.map(r => {
    const flt = activePenalties(db, r.result_id, 'FLT');
    const ral = activePenalties(db, r.result_id, 'RAL');
    const tt = ttTime(db, eventId, r.athlete_id);
    let cat, key;
    if (r.status === 'DSQ')      { cat = CAT.DSQ; key = { tt }; }
    else if (r.status === 'DNS') { cat = CAT.DNS; key = { tt }; }
    else if (r.status === 'DNF') { cat = CAT.DNF; key = { tt }; }
    else if (ral.length)         { cat = CAT.RAL; key = { tt }; }
    else if (flt.length)         { cat = CAT.FLT; key = { flt, tt }; }
    else {
      const pos = finishOrder.indexOf(String(r.bib));
      cat = CAT.CLEAN;
      key = { pos: pos === -1 ? BIG : pos };
    }
    return { row: r, cat, key };
  });

  entries.sort((a, b) => {
    if (a.cat !== b.cat) return a.cat - b.cat;
    switch (a.cat) {
      case CAT.CLEAN: return a.key.pos - b.key.pos;
      case CAT.FLT: {
        const c = compareFaults(a.key.flt, b.key.flt);
        return c !== 0 ? c : a.key.tt - b.key.tt;
      }
      default: return a.key.tt - b.key.tt;   // RAL / DNF / DNS / DSQ: TT time
    }
  });

  const upd = db.prepare('UPDATE result SET rank = ? WHERE result_id = ?');
  entries.forEach((e, i) => upd.run(i + 1, e.row.result_id));
  return entries.map((e, i) => ({ ...e.row, rank: i + 1 }));
}

/**
 * Rank the Time Trial. A fault during TT is still a fault: this uses the
 * exact same category system as rankHeat (clean < FLT < RAL < DNF < DNS
 * < DSQ) rather than sorting purely by time_ms — a faulted athlete must
 * never outrank a clean one just because their computed time happens to
 * be a smaller number. time_ms itself is left untouched either way (kept
 * for potential protests); it's only de-prioritized as a *sort key* for
 * anyone with an active FLT/RAL/status, not hidden or cleared.
 *
 * For the CLEAN category, time_ms IS the primary sort key (there's no
 * separate "finish order" in a Time Trial — the clock is the finish
 * order). For the FLT category, the same fault-gate comparison used in
 * rankHeat decides first; time_ms only breaks a tie between two athletes
 * who faulted at the exact same gate(s).
 */
function rankTimeTrial(db, eventId) {
  const rows = db.prepare(
    `SELECT result_id, time_ms, status FROM result
      WHERE event_id = ? AND phase = 'TT'`
  ).all(eventId);

  const entries = rows.map(r => {
    const flt = activePenalties(db, r.result_id, 'FLT');
    const ral = activePenalties(db, r.result_id, 'RAL');
    const time = r.time_ms ?? BIG;
    let cat, key;
    if (r.status === 'DSQ')      { cat = CAT.DSQ; key = { time }; }
    else if (r.status === 'DNS') { cat = CAT.DNS; key = { time }; }
    else if (r.status === 'DNF') { cat = CAT.DNF; key = { time }; }
    else if (ral.length)         { cat = CAT.RAL; key = { time }; }
    else if (flt.length)         { cat = CAT.FLT; key = { flt, time }; }
    else                         { cat = CAT.CLEAN; key = { time }; }
    return { row: r, cat, key };
  });

  entries.sort((a, b) => {
    if (a.cat !== b.cat) return a.cat - b.cat;
    if (a.cat === CAT.FLT) {
      const c = compareFaults(a.key.flt, b.key.flt);
      return c !== 0 ? c : a.key.time - b.key.time;
    }
    return a.key.time - b.key.time;
  });

  const upd = db.prepare('UPDATE result SET rank = ? WHERE result_id = ?');
  entries.forEach((e, i) => upd.run(i + 1, e.row.result_id));
  return entries.length;
}

module.exports = { rankHeat, rankTimeTrial, compareFaults };
