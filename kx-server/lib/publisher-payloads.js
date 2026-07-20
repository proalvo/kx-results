'use strict';

// lib/publisher-payloads.js — maps THIS kx-server's SQLite schema to the
// KX-Web Sync API payload shapes (see docs/kx-web-openapi.yaml in the
// kx-web package). Zero dependencies; works with node:sqlite's
// DatabaseSync (better-sqlite3-compatible .prepare().get/.all).
//
// Schema facts this file relies on (schema.sql):
//   * phases:            TT | Q | RQ | QF | SF | F | RESULT
//   * result:            group_no/slot_no, time_ms, rank, status (DNS/DNF/DSQ)
//   * result_penalty:    per-gate FLT/RAL rows, revoked_at IS NULL = active
//   * event_athlete:     bib is TEXT (colour bibs), names/club/country copied
//   * event:             current_phase + live_tracking = what is live right now

// kx-server phase code <-> KX-Web enum
const PHASE_MAP = {
  TT: 'TIME_TRIAL',
  Q: 'QUALIFICATION',
  RQ: 'REPECHAGE',
  QF: 'QUARTER_FINAL',
  SF: 'SEMI_FINAL',
  F: 'FINAL',
  RESULT: 'OFFICIAL_RESULT'
};
const PHASE_MAP_REVERSE = Object.fromEntries(
  Object.entries(PHASE_MAP).map(([k, v]) => [v, k])
);

// Gate penalty encoding in the `gates` array sent to KX-Web
// (display-only on the website; ranking stays in kx-server):
//   null = no penalty on this gate, 1 = FLT, 2 = RAL
const GATE_FLT = 1;
const GATE_RAL = 2;

const toWebPhase = (p) => {
  const w = PHASE_MAP[String(p).toUpperCase()];
  if (!w) throw new Error(`Unknown kx-server phase: ${p}`);
  return w;
};
const toLocalPhase = (w) => {
  const p = PHASE_MAP_REVERSE[w];
  if (!p) throw new Error(`Unknown web phase: ${w}`);
  return p;
};

/** CompetitionSync: competition metadata + its event list. */
function buildCompetitionSync(db, competitionId) {
  const c = db.prepare(
    `SELECT competition_id, competition_name, country, location,
            start_date, end_date, time_zone, type
       FROM competition WHERE competition_id = ?`
  ).get(competitionId);
  if (!c) throw new Error(`Competition not found: ${competitionId}`);

  const events = db.prepare(
    `SELECT event_id, event_code, event_name, gates
       FROM event WHERE competition_id = ?
       ORDER BY event_code`
  ).all(competitionId);

  return {
    competition_id: c.competition_id,
    name: c.competition_name,
    country: c.country,
    location: c.location ?? '',
    start_date: c.start_date,
    end_date: c.end_date,
    time_zone: c.time_zone ?? 'Europe/Helsinki',
    // kx-server stores DOMESTIC/INTERNATIONAL/MIXED; web expects capitalized
    comp_type: { DOMESTIC: 'Domestic', INTERNATIONAL: 'International', MIXED: 'Mixed' }[c.type] ?? 'Domestic',
    events: events.map((e, i) => ({
      event_id: e.event_id,
      event_code: e.event_code,
      event_name: e.event_name,
      gates: e.gates,
      sort_order: i
    }))
  };
}

/**
 * PhaseSync: full snapshot of one phase of one event.
 * @param {string} webPhase  KX-Web enum, e.g. 'QUALIFICATION'
 * @param {{status?: 'startlist'|'live'|'official'}} [opts]  explicit override
 */
function buildPhaseSync(db, eventId, webPhase, opts = {}) {
  const event = db.prepare(
    `SELECT event_id, event_code, gates, current_phase, live_tracking
       FROM event WHERE event_id = ?`
  ).get(eventId);
  if (!event) throw new Error(`Event not found: ${eventId}`);

  const localPhase = toLocalPhase(webPhase);

  const rows = db.prepare(
    `SELECT r.result_id, r.group_no, r.slot_no, r.time_ms, r.rank, r.status,
            ea.bib, ea.first_name, ea.last_name, ea.club, ea.country,
            a.icf_id, a.nf_id
       FROM result r
       JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
       JOIN athlete a        ON a.athlete_id = r.athlete_id
      WHERE r.event_id = ? AND r.phase = ?
      ORDER BY r.group_no, r.slot_no`
  ).all(eventId, localPhase);

  // Active penalties for the whole phase in one query
  const penalties = db.prepare(
    `SELECT rp.result_id, rp.gate_no, rp.penalty
       FROM result_penalty rp
       JOIN result r ON r.result_id = rp.result_id
      WHERE r.event_id = ? AND r.phase = ? AND rp.revoked_at IS NULL`
  ).all(eventId, localPhase);
  const byResult = new Map();
  for (const p of penalties) {
    if (!byResult.has(p.result_id)) byResult.set(p.result_id, []);
    byResult.get(p.result_id).push(p);
  }

  const entries = rows.map((r) => {
    const gates = Array.from({ length: event.gates }, () => null);
    let ral = false;
    for (const p of byResult.get(r.result_id) ?? []) {
      if (p.gate_no >= 1 && p.gate_no <= event.gates) {
        gates[p.gate_no - 1] = p.penalty === 'RAL' ? GATE_RAL : GATE_FLT;
      }
      if (p.penalty === 'RAL') ral = true;
    }
    return {
      grp: r.group_no ?? 1,
      slot_no: r.slot_no,
      bib: r.bib ?? null,                        // TEXT — colour bibs supported
      rank: r.rank ?? null,
      first_name: r.first_name,
      last_name: r.last_name,
      club: r.club ?? '',
      country: r.country ?? '',
      icf_id: r.icf_id ?? null,
      nf_id: r.nf_id ?? null,
      score: r.time_ms != null ? r.time_ms / 1000 : null,   // seconds for display
      dns: r.status === 'DNS',
      dnf: r.status === 'DNF',
      dsq: r.status === 'DSQ',
      ral,
      gates
    };
  });

  return {
    event_code: event.event_code,
    phase: webPhase,
    status: opts.status ?? deriveStatus(event, localPhase, entries),
    entries
  };
}

/** FullSync: competition + events + every phase that has rows. */
function buildFullSync(db, competitionId, opts = {}) {
  const competition = buildCompetitionSync(db, competitionId);
  const phaseRows = db.prepare(
    `SELECT DISTINCT r.event_id, r.phase
       FROM result r
       JOIN event e ON e.event_id = r.event_id
      WHERE e.competition_id = ?`
  ).all(competitionId);

  const phases = phaseRows.map(({ event_id, phase }) =>
    buildPhaseSync(db, event_id, toWebPhase(phase), {
      status: opts.statusFor?.(event_id, toWebPhase(phase))
    })
  );
  return { ...competition, phases };
}

/**
 * Phases changed since a watermark (ISO-8601 UTC string) — used by the
 * notify() hook to publish only what is dirty. Covers result edits,
 * penalty grants/revocations, and athlete info fixes.
 */
function dirtyPhases(db, competitionId, sinceIso) {
  return db.prepare(
    `SELECT DISTINCT r.event_id, r.phase
       FROM result r
       JOIN event e ON e.event_id = r.event_id
       LEFT JOIN result_penalty rp ON rp.result_id = r.result_id
       LEFT JOIN event_athlete ea ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
      WHERE e.competition_id = ?
        AND (r.updated_at >= ?
             OR ea.updated_at >= ?
             OR rp.issued_at >= ?
             OR rp.revoked_at >= ?)`
  ).all(competitionId, sinceIso, sinceIso, sinceIso, sinceIso)
    .map((row) => ({ eventId: row.event_id, webPhase: toWebPhase(row.phase) }));
}

/**
 * Default status when the Chief has not explicitly published:
 *  - live      when the Chief is tracking exactly this phase (live_tracking)
 *  - official  for the RESULT phase, or when every entry is ranked/settled
 *  - startlist otherwise until any result data appears, then live
 */
function deriveStatus(event, localPhase, entries) {
  if (event.live_tracking === 1 && event.current_phase === localPhase) return 'live';
  if (localPhase === 'RESULT') return 'official';
  if (entries.length > 0 &&
      entries.every((e) => e.rank !== null || e.dns || e.dnf || e.dsq)) return 'official';
  const anyData = entries.some(
    (e) => e.rank !== null || e.score !== null || e.gates.some((g) => g !== null)
  );
  return anyData ? 'live' : 'startlist';
}

module.exports = {
  buildCompetitionSync,
  buildPhaseSync,
  buildFullSync,
  dirtyPhases,
  toWebPhase,
  toLocalPhase,
  deriveStatus,
  PHASE_MAP,
  GATE_FLT,
  GATE_RAL
};
