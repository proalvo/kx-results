
// lib/competition-results.js — overall competition results (all events).
//
// Feeds the "Print competition results" PDF (public/print-competition.html).
// The Phase page already prints ONE phase at a time; this builds the
// document the Chief of Scoring hands to the jury and the notice board at
// the end of the day: every event of the competition, each with its final
// classification.
//
// Where the classification comes from, in order of preference:
//
//   1. phase = 'RESULT' rows — the official classification compiled by
//      progression.js/compileOfficialResult() from the rule's RESULT lines.
//      This is the authoritative source and is used whenever it exists.
//
//   2. A PROVISIONAL classification derived from the furthest phase that
//      has been ranked. This is not a shortcut: both rule books provide
//      for it explicitly when an event cannot be completed —
//        * SMSL Koskicross 2023 §9.3.1: if the competition cannot be
//          finished, the Chief Judge may confirm the final results from
//          the last completed phase (time trial, qualification or semis);
//        * §9.3.2: winners of that phase are classified first, ordered by
//          time trial time, then the second places, and so on.
//      Athletes eliminated earlier are appended below, grouped by how far
//      they got (§9.2.1: athletes eliminated at the same stage are ranked
//      against each other on time trial time). Rows produced this way are
//      flagged `provisional: true` and the event carries status
//      'PROVISIONAL' so the printed sheet can say so plainly — an
//      unfinished event must never look official on paper.
//
// Nothing here writes to the database: printing is a read-only view of
// whatever the Chief has already confirmed. Compiling the official result
// stays an explicit action on the Phase page (POST /api/official-result).

'use strict';

// Only used for the human-readable note below. Presentation labels for the
// printed sheet live in public/print-competition.html, matching print.html's
// self-contained-page convention.
const PHASE_LABELS = {
  TT: 'Time Trial', Q: 'Qualification', RQ: 'Repechage Qualification',
  QF: 'Quarterfinal', SF: 'Semifinal', F: 'Final', RESULT: 'Official Result',
};

// "How far did this athlete get" — higher wins. RESULT is deliberately
// absent: it is a classification, not a round that was paddled.
const PHASE_DEPTH = { TT: 0, Q: 1, RQ: 2, QF: 3, SF: 4, F: 5 };

const BIG = Number.MAX_SAFE_INTEGER;

// first_name_initial already carries its trailing dot in the database
// (see event_athlete), so no punctuation is added here.
function shortName(a) {
  const initial = a.first_name_initial || (a.first_name ? a.first_name[0] : '');
  return (initial ? initial + ' ' : '') + (a.last_name || '');
}

function fullName(a) {
  return [a.first_name, a.last_name].filter(Boolean).join(' ');
}

function selectRows(db, eventId) {
  return db.prepare(
    `SELECT r.result_id, r.phase, r.group_no, r.slot_no, r.rank, r.time_ms, r.status,
            r.athlete_id,
            g.gate1, g.gate2, g.gate3, g.gate4, g.gate5, g.gate6, g.gate7, g.gate8
       FROM result r
       LEFT JOIN v_result_gates g ON g.result_id = r.result_id
      WHERE r.event_id = ?`
  ).all(eventId);
}

function selectEntrants(db, eventId) {
  return db.prepare(
    `SELECT athlete_id, bib, list_order, first_name, first_name_initial,
            last_name, club, country
       FROM event_athlete WHERE event_id = ? ORDER BY list_order`
  ).all(eventId);
}

/**
 * Per-athlete summary used by both classification paths:
 *   tt      — Time Trial time in ms (BIG when missing, so it sorts last)
 *   deepest — the furthest phase actually paddled (never 'RESULT')
 *   byPhase — phase -> result row
 */
function summarise(entrants, rows) {
  const byAthlete = new Map();
  for (const a of entrants) {
    byAthlete.set(a.athlete_id, {
      athlete: a, byPhase: {}, tt: BIG, deepest: null, resultRow: null,
    });
  }
  for (const r of rows) {
    const s = byAthlete.get(r.athlete_id);
    if (!s) continue;                                  // athlete removed from the event
    if (r.phase === 'RESULT') { s.resultRow = r; continue; }
    s.byPhase[r.phase] = r;
    if (r.phase === 'TT' && r.time_ms != null) s.tt = r.time_ms;
    if (s.deepest == null || PHASE_DEPTH[r.phase] > PHASE_DEPTH[s.deepest]) {
      s.deepest = r.phase;
    }
  }
  return byAthlete;
}

/** The phase an athlete's result sheet note should come from. */
function eliminationRow(s) {
  return s.deepest ? s.byPhase[s.deepest] : null;
}

function printableRow(s, rank, provisional) {
  const a = s.athlete;
  const elim = eliminationRow(s);
  // Raw penalty/status fields from the run the athlete went out in, so the
  // print page can format them with the very same timeOrFault() that
  // print.html uses. Formatting deliberately does NOT happen here: two
  // formatters for one value is how a results sheet ends up disagreeing
  // with the screen it was printed from.
  const gates = {};
  for (let g = 1; g <= 8; g++) gates['gate' + g] = elim ? (elim['gate' + g] ?? null) : null;
  return {
    rank,
    provisional,
    athlete_id: a.athlete_id,
    bib: a.bib ?? '',
    name: fullName(a),
    short_name: shortName(a),
    first_name: a.first_name,
    last_name: a.last_name,
    club: a.club ?? '',
    country: a.country ?? '',
    // Where the athlete's competition ended, and with what marking —
    // an official sheet shows FLT/RAL/DNF/DNS, not just a bare rank.
    eliminated_phase: s.deepest,
    eliminated_group: elim ? elim.group_no : null,
    status: elim ? elim.status ?? null : null,
    ...gates,
    tt_time_ms: s.tt === BIG ? null : s.tt,
    tt_rank: s.byPhase.TT ? s.byPhase.TT.rank ?? null : null,
  };
}

/**
 * Provisional ordering for an event that has no compiled RESULT.
 *
 * Sort key, in order:
 *   1. furthest phase reached  (descending — finalists above semi-finalists)
 *   2. within a FINAL only: group_no ascending, so the A final outranks the
 *      small final regardless of the rank numbers inside each heat
 *   3. rank in that phase (ascending; unranked last)   — §9.3.2
 *   4. Time Trial time (ascending; missing last)       — §9.2.1 / §9.3.2
 *
 * Step 3 before step 4 is what §9.3.2 asks for: all the winners of the
 * last completed round first (ordered among themselves by TT time), then
 * all the runners-up, and so on.
 */
function compareProvisional(a, b) {
  const da = a.deepest ? PHASE_DEPTH[a.deepest] : -1;
  const db_ = b.deepest ? PHASE_DEPTH[b.deepest] : -1;
  if (da !== db_) return db_ - da;
  if (a.deepest === 'F' && b.deepest === 'F') {
    const ga = a.byPhase.F.group_no ?? 1, gb = b.byPhase.F.group_no ?? 1;
    if (ga !== gb) return ga - gb;                     // Final above Small Final
  }
  const ra = a.deepest ? (a.byPhase[a.deepest].rank ?? BIG) : BIG;
  const rb = b.deepest ? (b.byPhase[b.deepest].rank ?? BIG) : BIG;
  if (ra !== rb) return ra - rb;
  return a.tt - b.tt;
}

/**
 * Final classification for one event.
 * @returns {{status:'OFFICIAL'|'PROVISIONAL'|'PENDING', source_phase:string|null,
 *            rows:Array, unclassified:Array, notes:string[]}}
 */
function classifyEvent(db, event, opts = {}) {
  const entrants = selectEntrants(db, event.event_id);
  const rows = selectRows(db, event.event_id);
  const byAthlete = summarise(entrants, rows);
  const notes = [];

  const official = [...byAthlete.values()]
    .filter(s => s.resultRow && s.resultRow.rank != null)
    .sort((a, b) => a.resultRow.rank - b.resultRow.rank);

  let out = [], status = 'PENDING', sourcePhase = null;

  if (official.length) {
    status = 'OFFICIAL';
    sourcePhase = 'RESULT';
    out = official.map(s => printableRow(s, s.resultRow.rank, false));
  } else if (opts.includeProvisional !== false) {
    const ranked = [...byAthlete.values()].filter(s => s.deepest != null);
    // Something must actually have been judged — a bare start list is not
    // a provisional result, it is a start list.
    const anyRanked = ranked.some(s => s.byPhase[s.deepest].rank != null);
    if (anyRanked) {
      status = 'PROVISIONAL';
      const sorted = ranked.slice().sort(compareProvisional);
      sourcePhase = sorted.length ? sorted[0].deepest : null;
      out = sorted.map((s, i) => printableRow(s, i + 1, true));
      notes.push(
        `No official classification has been compiled for this event. ` +
        `Provisional order derived from the last judged phase ` +
        `(${PHASE_LABELS[sourcePhase] ?? sourcePhase}).`);
    }
  }

  const placed = new Set(out.map(r => r.athlete_id));
  const unclassified = entrants
    .filter(a => !placed.has(a.athlete_id))
    .map(a => {
      const s = byAthlete.get(a.athlete_id);
      return printableRow(s, null, status === 'PROVISIONAL');
    });

  if (status === 'OFFICIAL' && unclassified.length) {
    notes.push(
      `${unclassified.length} entrant(s) have no place in the official ` +
      `classification — check the progression rule for gaps.`);
  }

  return { status, source_phase: sourcePhase, rows: out, unclassified, notes };
}

/**
 * Everything the overall-results PDF needs, in one call.
 * @param {object} db
 * @param {string} competitionId
 * @param {{eventIds?:string[], includeProvisional?:boolean}} [opts]
 */
function buildCompetitionResults(db, competitionId, opts = {}) {
  const competition = db.prepare(
    `SELECT competition_id, competition_name, start_date, end_date, country,
            location, time_zone, type
       FROM competition WHERE competition_id = ?`
  ).get(competitionId);
  if (!competition) throw new Error(`Competition not found: ${competitionId}`);

  // Organiser's running order (see event.sort_order): the printed overall
  // results sheet is pinned to the notice board next to the schedule, so
  // the events should appear in the same order they were actually run.
  let events = db.prepare(
    `SELECT event_id, event_code, event_name, gates, rule_id, sort_order
       FROM event WHERE competition_id = ? ORDER BY sort_order, event_code`
  ).all(competitionId);

  if (Array.isArray(opts.eventIds) && opts.eventIds.length) {
    const wanted = new Set(opts.eventIds);
    events = events.filter(e => wanted.has(e.event_id));
  }

  return {
    competition,
    generated_at: new Date().toISOString(),
    events: events.map(e => ({
      event_id: e.event_id,
      event_code: e.event_code,
      event_name: e.event_name,
      gates: e.gates,
      ...classifyEvent(db, e, opts),
    })),
  };
}

module.exports = {
  buildCompetitionResults,
  classifyEvent,
  compareProvisional,
  shortName,
  fullName,
  PHASE_LABELS,
  PHASE_DEPTH,
};

