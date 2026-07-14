// lib/api.js — JSON API for KX-Results.
//
// Follows the "notify + fetch" pattern decided during design review:
// mutations emit a lightweight change event (see server.js /api/stream);
// clients then re-fetch state via these endpoints. The same endpoints will
// later feed the Gate Judge page, streaming graphics and website sync.

'use strict';
const { uuid } = require('./db');
const { rankHeat, rankTimeTrial } = require('./ranking');
const { importRuleJson, applyProgression, compileOfficialResult, checkRuleFits } = require('./progression');
const { computeTTResultTimeMs, splitTimingEnabled } = require('./tt-timing');

// Turns a raw "UNIQUE constraint failed: table.column" into a message a
// Chief of Scoring can actually act on, instead of the raw SQLite string.
function friendlyError(e) {
  const m = /UNIQUE constraint failed: \w+\.(\w+)/.exec(e.message);
  if (m) return new Error(`That ${m[1].replace(/_/g, ' ')} is already in use.`);
  return e;
}

function api(db, notify) {
  const routes = {};
  const on = (method, path, fn) => { routes[`${method} ${path}`] = fn; };

  // ---------------------------------------------------------- competitions
  on('GET', '/api/competitions', () =>
    db.prepare('SELECT * FROM competition ORDER BY start_date DESC').all());

  on('POST', '/api/competitions', (q, body) => {
    const id = uuid();
    db.prepare(
      `INSERT INTO competition (competition_id, competition_name, start_date,
         end_date, country, location, time_zone, type, gate_judge_pin, api_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, body.competition_name, body.start_date, body.end_date,
          body.country, body.location ?? null,
          body.time_zone ?? 'Europe/Helsinki', body.type ?? 'DOMESTIC',
          body.gate_judge_pin ?? '0000', body.api_key ?? null);
    for (const email of body.admins ?? []) {
      db.prepare(`INSERT INTO competition_admin (competition_id, email)
                  VALUES (?, ?)`).run(id, email);
    }
    notify('competitions');
    return { competition_id: id };
  });

  on('PATCH', '/api/competitions', (q, body) => {
    const allowed = ['competition_name', 'start_date', 'end_date', 'country',
      'location', 'type', 'tt_start_interval_ms', 'tt_time_shift_ms'];
    const sets = allowed.filter(k => k in body);
    if (!sets.length) throw new Error('Nothing to update');
    try {
      db.prepare(`UPDATE competition SET ${sets.map(k => `${k} = ?`).join(', ')}
                  WHERE competition_id = ?`)
        .run(...sets.map(k => body[k]), body.competition_id);
    } catch (e) { throw friendlyError(e); }
    notify('competitions');
    return { ok: true };
  });

  // -------------------------------------------------------------- gate judge
  // PIN check happens server-side only — the Gate Judge page never receives
  // or compares the real PIN client-side, so it can't be read out of the
  // page source. This is a shared-secret gate (matching the spec's "PIN
  // code for Gate Judge's UI"), not a full account system: anyone at the
  // venue with the PIN can act as any gate judge for that competition.
  on('POST', '/api/gate-judge/login', (q, body) => {
    const comp = db.prepare('SELECT competition_id, competition_name, gate_judge_pin FROM competition WHERE competition_id = ?')
      .get(body.competition_id);
    if (!comp || String(body.pin ?? '') !== comp.gate_judge_pin) {
      throw new Error('Incorrect PIN for this competition.');
    }
    return { ok: true, competition_name: comp.competition_name };
  });

  // ---------------------------------------------------------- stream state
  // "Remote control" for the OBS-facing streaming pages — see schema.sql's
  // comment on stream_state for why this exists (one fixed URL per stream,
  // operable via a control page instead of swapping URLs mid-competition).
  on('GET', '/api/stream-state', q => {
    const row = db.prepare('SELECT * FROM stream_state WHERE stream_key = ?').get(q.key);
    return row ?? { stream_key: q.key, event_id: null, mode: null, phase: null, group_no: null };
  });

  on('PATCH', '/api/stream-state', (q, body) => {
    if (!['startlist', 'results'].includes(body.stream_key)) {
      throw new Error(`Invalid stream_key "${body.stream_key}"`);
    }
    db.prepare(`INSERT INTO stream_state (stream_key, event_id, mode, phase, group_no)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(stream_key) DO UPDATE SET
                  event_id = excluded.event_id, mode = excluded.mode,
                  phase = excluded.phase, group_no = excluded.group_no`)
      .run(body.stream_key, body.event_id ?? null, body.mode ?? null,
           body.phase ?? null, body.group_no ?? null);
    notify('stream-state');
    return { ok: true };
  });

  // ------------------------------------------------------------- app state
  // Session-wide "active competition" — see schema.sql's comment on
  // app_state. Read by the Phase and Setup pages instead of each having
  // their own competition picker; changed from the shared nav selector or
  // the "Start Here" page (start.html).
  on('GET', '/api/app-state', () => {
    const row = db.prepare(`SELECT a.*, c.competition_name FROM app_state a
                            LEFT JOIN competition c ON c.competition_id = a.active_competition_id
                            WHERE a.state_key = 'active'`).get();
    return row ?? { state_key: 'active', active_competition_id: null, competition_name: null };
  });

  on('PATCH', '/api/app-state', (q, body) => {
    db.prepare(`INSERT INTO app_state (state_key, active_competition_id)
                VALUES ('active', ?)
                ON CONFLICT(state_key) DO UPDATE SET
                  active_competition_id = excluded.active_competition_id`)
      .run(body.active_competition_id ?? null);
    notify('app-state');
    return { ok: true };
  });

  // ---------------------------------------------------------------- events
  on('GET', '/api/events', q =>
    db.prepare(`SELECT e.*, pr.rule_name, pr.min_athletes, pr.max_athletes,
                (SELECT COUNT(*) FROM event_athlete ea WHERE ea.event_id = e.event_id) AS athlete_count
                FROM event e
                LEFT JOIN progression_rule pr ON pr.rule_id = e.rule_id
                WHERE e.competition_id = ?`).all(q.competition_id));

  // Single-event lookup joined with its competition's type/country. Streaming
  // pages (see public/stream-*.html) only know event_id from their URL —
  // this gives them everything needed (active-heat pointer + the
  // Domestic/International/Mixed rule's inputs) in one call.
  on('GET', '/api/stream-info', q => {
    const row = db.prepare(`
      SELECT e.event_id, e.event_code, e.event_name, e.gates,
             e.current_phase, e.current_group,
             c.competition_id, c.competition_name, c.type AS competition_type,
             c.country AS competition_country
        FROM event e
        JOIN competition c ON c.competition_id = e.competition_id
       WHERE e.event_id = ?`).get(q.event_id);
    if (!row) throw new Error('Unknown event_id');
    return row;
  });

  on('POST', '/api/events', (q, body) => {
    const id = uuid();
    db.prepare(
      `INSERT INTO event (event_id, competition_id, event_code, event_name,
         gates, rule_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, body.competition_id, body.event_code, body.event_name,
          body.gates, body.rule_id ?? null);
    notify('events');
    return { event_id: id };
  });

  on('PATCH', '/api/events', (q, body) => {
    // current_phase/current_group is the "active heat" pointer: the Phase
    // page sets it when the Chief starts judging a heat, and Gate Judge
    // pages read it (via GET /api/events, below) to know what to show
    // without any manual navigation on the judge's phone.
    const allowed = ['event_code', 'event_name', 'gates', 'rule_id',
      'current_phase', 'current_group', 'live_tracking'];
    const sets = allowed.filter(k => k in body);
    if (!sets.length) throw new Error('Nothing to update');
    try {
      db.prepare(`UPDATE event SET ${sets.map(k => `${k} = ?`).join(', ')}
                  WHERE event_id = ?`)
        .run(...sets.map(k => body[k]), body.event_id);
    } catch (e) { throw friendlyError(e); }
    notify('events');
    return { ok: true };
  });

  on('DELETE', '/api/events', (q, body) => {
    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM event_athlete WHERE event_id = ?`).get(body.event_id).c;
    if (count > 0) {
      throw new Error(
        `Cannot delete this event — it has ${count} athlete(s) uploaded. ` +
        `Remove them individually first, or don't delete the event.`);
    }
    db.prepare('DELETE FROM event WHERE event_id = ?').run(body.event_id);
    notify('events');
    return { ok: true };
  });

  // ----------------------------------------------------------------- rules
  on('GET', '/api/rules', () =>
    db.prepare(`SELECT pr.*,
                (SELECT COUNT(*) FROM progression_rule_step prs WHERE prs.rule_id = pr.rule_id) AS step_count
                FROM progression_rule pr ORDER BY pr.rule_name`).all());

  on('POST', '/api/rules', (q, body) => {
    // body IS the rule (see /rules/*.json for examples) — rule_name,
    // description, min/max athletes, progression, and final_result all
    // come from the uploaded file itself; there's nothing left to pass
    // separately. importRuleJson validates structure and throws a clear,
    // field-specific error for anything malformed.
    const r = importRuleJson(db, body);
    notify('rules');
    return r;
  });

  on('PATCH', '/api/rules', (q, body) => {
    // Deliberately limited to name/description: steps and min/max athletes
    // define what the rule actually DOES and are tied to already-run events
    // (see checkRuleFits) — changing them here would be a silent, dangerous
    // edit. Re-upload a new rule instead for any structural change.
    const allowed = ['rule_name', 'description'];
    const sets = allowed.filter(k => k in body);
    if (!sets.length) throw new Error('Nothing to update');
    try {
      db.prepare(`UPDATE progression_rule SET ${sets.map(k => `${k} = ?`).join(', ')}
                  WHERE rule_id = ?`)
        .run(...sets.map(k => body[k]), body.rule_id);
    } catch (e) { throw friendlyError(e); }
    notify('rules');
    return { ok: true };
  });

  // ------------------------------------------------ athletes upload (spec)
  on('GET', '/api/athletes', q =>
    db.prepare(`SELECT * FROM event_athlete WHERE event_id = ?
                ORDER BY list_order`).all(q.event_id));

  // CSV: event;bib;first_name;last_name;club;country;icf_id;nf_id
  on('POST', '/api/athletes/upload', (q, body) => {
    const lines = body.csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    lines.shift();                                   // first row = instructions
    const findEvent = db.prepare(
      `SELECT event_id FROM event WHERE competition_id = ? AND event_code = ?`);
    const findAthlete = db.prepare(                  // match on ICF/NF id first
      `SELECT athlete_id FROM athlete
        WHERE (icf_id IS NOT NULL AND icf_id = ?)
           OR (nf_id  IS NOT NULL AND nf_id  = ?) LIMIT 1`);
    const maxListOrder = db.prepare(
      `SELECT COALESCE(MAX(list_order), 0) AS m FROM event_athlete WHERE event_id = ?`);
    let added = 0; const errors = [];
    const nextSeq = new Map();                        // event_id -> next list_order to assign
    db.exec('BEGIN');
    try {
      for (const [i, line] of lines.entries()) {
        const [evCode, bib, first, last, club, country, icf, nf] =
          line.split(';').map(s => s.trim());
        const ev = findEvent.get(body.competition_id, evCode);
        if (!ev) { errors.push(`Line ${i + 2}: unknown event "${evCode}"`); continue; }
        let athleteId = (icf || nf)
          ? findAthlete.get(icf || null, nf || null)?.athlete_id : null;
        if (!athleteId) {
          athleteId = uuid();
          db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name,
                        club, country, icf_id, nf_id) VALUES (?,?,?,?,?,?,?)`
          ).run(athleteId, first, last, club || null, country || null,
                icf || null, nf || null);
        }
        if (!nextSeq.has(ev.event_id)) nextSeq.set(ev.event_id, maxListOrder.get(ev.event_id).m);
        const listOrder = nextSeq.get(ev.event_id) + 1;
        nextSeq.set(ev.event_id, listOrder);
        db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
                      first_name, first_name_initial, last_name, club, country)
                    VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(ev.event_id, athleteId, bib, listOrder, first, first[0] + '.', last,
              club || null, country || null);
        added++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    notify('athletes');
    return { added, errors };
  });

  on('DELETE', '/api/athletes', (q, body) => {
    // Removes this athlete from the EVENT only (deletes the event_athlete
    // row) — never the athlete table row, since that master record may be
    // shared across other events/competitions. Allowed only if the event
    // hasn't started: if ANY athlete in this event already has a recorded
    // TT time, the whole event is considered underway and removal is
    // blocked outright (not just for this athlete), since pulling someone
    // out mid-competition would misalign bibs/slots/list_order for
    // everyone else too.
    const started = db.prepare(
      `SELECT COUNT(*) AS c FROM result
        WHERE event_id = ? AND phase = 'TT' AND time_ms IS NOT NULL`).get(body.event_id).c;
    if (started > 0) {
      throw new Error(
        `Cannot remove an athlete — this event's Time Trial already has recorded times. ` +
        `Athletes can only be removed before the event starts.`);
    }
    db.exec('BEGIN');
    try {
      db.prepare(`DELETE FROM event_athlete WHERE event_id = ? AND athlete_id = ?`)
        .run(body.event_id, body.athlete_id);
      // Safe to also drop any pre-created TT placeholder row for this
      // athlete (e.g. from "Create Time Trial start list") — the guard
      // above already confirmed no times exist anywhere in this event.
      db.prepare(`DELETE FROM result WHERE event_id = ? AND athlete_id = ?`)
        .run(body.event_id, body.athlete_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    notify('athletes');
    return { ok: true };
  });

  // ------------------------------------------------------------ phase data
  on('GET', '/api/phase', q => {
    const rows = db.prepare(
      `SELECT r.result_id, r.phase, r.group_no, r.slot_no, r.time_ms, r.split_time_ms,
              r.finish_pos, r.rank,
              r.status, ea.bib, ea.first_name, ea.last_name, ea.club, ea.country,
              v.gate1, v.gate2, v.gate3, v.gate4, v.gate5, v.gate6, v.gate7, v.gate8,
              tt.time_ms AS tt_time_ms
         FROM result r
         JOIN event_athlete ea
           ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
         LEFT JOIN v_result_gates v ON v.result_id = r.result_id
         LEFT JOIN result tt ON tt.event_id = r.event_id
              AND tt.athlete_id = r.athlete_id AND tt.phase = 'TT'
        WHERE r.event_id = ? AND r.phase = ?
          AND (? = -1 OR r.group_no = ?)
        ORDER BY r.group_no, COALESCE(r.rank, r.slot_no), r.slot_no`
    ).all(q.event_id, q.phase, +(q.group_no ?? -1), +(q.group_no ?? -1));
    return rows;
  });

  on('GET', '/api/phases', q =>
    db.prepare(`SELECT DISTINCT phase, group_no FROM result
                WHERE event_id = ? ORDER BY
                CASE phase WHEN 'TT' THEN 0 WHEN 'Q' THEN 1 WHEN 'RQ' THEN 2
                           WHEN 'QF' THEN 3 WHEN 'SF' THEN 4 WHEN 'F' THEN 5
                           WHEN 'RESULT' THEN 6 END, group_no`
    ).all(q.event_id));

  // Seed the Time Trial start list from the event's entries (start order = bib)
  on('POST', '/api/phase/start-tt', (q, body) => {
    const entries = db.prepare(
      `SELECT athlete_id, bib FROM event_athlete WHERE event_id = ?
       ORDER BY list_order`).all(body.event_id);
    if (!body.force) {
      const ev = db.prepare('SELECT rule_id FROM event WHERE event_id = ?').get(body.event_id);
      const rule = ev?.rule_id
        ? db.prepare('SELECT * FROM progression_rule WHERE rule_id = ?').get(ev.rule_id)
        : null;
      if (rule) {
        const check = checkRuleFits(rule, entries.length);
        if (!check.fits) {
          throw new Error(check.reason +
            ' Choose a different rule for this event, or pass force=true to proceed anyway.');
        }
      }
    }
    const ins = db.prepare(
      `INSERT INTO result (result_id, event_id, athlete_id, phase, group_no, slot_no)
       VALUES (?, ?, ?, 'TT', 1, ?)`);
    entries.forEach((e, i) => ins.run(uuid(), body.event_id, e.athlete_id, i + 1));
    notify('results');
    return { created: entries.length };
  });

  // ------------------------------------------- manual edits (Chief disposes)
  on('PATCH', '/api/result', (q, body) => {
    const allowed = ['time_ms', 'finish_pos', 'split_time_ms', 'status', 'rank', 'slot_no', 'group_no'];
    const sets = allowed.filter(k => k in body);
    if (!sets.length) throw new Error('Nothing to update');
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE result SET ${sets.map(k => `${k} = ?`).join(', ')}
                  WHERE result_id = ?`)
        .run(...sets.map(k => body[k]), body.result_id);

      // Split-time TT timing: if this row now has a split time recorded
      // (just set, or already present and slot_no just changed), recompute
      // the actual result time_ms from it. Only applies to TT rows on a
      // competition that has the feature configured — everywhere else this
      // is a no-op and time_ms behaves exactly as it always has. Wrapped in
      // the same transaction as the initial update: if the recompute fails
      // (e.g. a negative result — bad data entry), the whole PATCH rolls
      // back rather than leaving split_time_ms saved with a stale time_ms.
      if (sets.includes('split_time_ms') || sets.includes('slot_no')) {
        const row = db.prepare(
          `SELECT r.result_id, r.phase, r.slot_no, r.split_time_ms, c.tt_start_interval_ms, c.tt_time_shift_ms
             FROM result r
             JOIN event e ON e.event_id = r.event_id
             JOIN competition c ON c.competition_id = e.competition_id
            WHERE r.result_id = ?`).get(body.result_id);
        if (row && row.phase === 'TT' && row.split_time_ms != null && splitTimingEnabled(row)) {
          const timeMs = computeTTResultTimeMs(
            row.split_time_ms, row.slot_no, row.tt_start_interval_ms, row.tt_time_shift_ms);
          db.prepare('UPDATE result SET time_ms = ? WHERE result_id = ?').run(timeMs, body.result_id);
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    notify('results');
    // Include the current time_ms so a split_time_ms save can update the
    // computed Time display in place, without reloading the whole table
    // (which would steal focus from wherever the Chief has tabbed to next).
    const time_ms = db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
      .get(body.result_id)?.time_ms ?? null;
    return { ok: true, time_ms };
  });

  on('POST', '/api/result', (q, body) => {          // manual add to start list
    // NOT currently exposed in the Phase page UI: real-world use (re-adding
    // to a phase, targeting an occupied slot) surfaces raw SQLite constraint
    // errors rather than a usable message. Proper athlete management is
    // deferred to the athlete upload feature; this endpoint remains for
    // scripts/tests and can be re-wired into the UI with friendlier error
    // handling once that feature lands.
    const ea = db.prepare(`SELECT athlete_id FROM event_athlete
                           WHERE event_id = ? AND bib = ?`)
      .get(body.event_id, String(body.bib));
    if (!ea) throw new Error(`No athlete with bib ${body.bib} in this event`);
    const id = uuid();
    db.prepare(`INSERT INTO result (result_id, event_id, athlete_id, phase,
                  group_no, slot_no) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, body.event_id, ea.athlete_id, body.phase, body.group_no, body.slot_no);
    notify('results');
    return { result_id: id };
  });

  on('DELETE', '/api/result', (q, body) => {        // manual remove
    db.prepare('DELETE FROM result WHERE result_id = ?').run(body.result_id);
    notify('results');
    return { ok: true };
  });

  // -------------------------------------------------------------- penalties
  on('POST', '/api/penalty', (q, body) => {
    db.prepare(`INSERT INTO result_penalty (penalty_id, result_id, gate_no,
                  penalty, issued_by) VALUES (?, ?, ?, ?, ?)`)
      .run(uuid(), body.result_id, body.gate_no, body.penalty,
           body.issued_by ?? 'chief');
    notify('results');
    return { ok: true };
  });

  on('POST', '/api/penalty/revoke', (q, body) => {  // audit: never deleted
    db.prepare(`UPDATE result_penalty
                SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_by = ?
                WHERE result_id = ? AND gate_no = ? AND revoked_at IS NULL`)
      .run(body.revoked_by ?? 'chief', body.result_id, body.gate_no);
    notify('results');
    return { ok: true };
  });

  // ----------------------------------------------------- ranking + progression
  on('POST', '/api/rank', (q, body) => {
    const n = body.phase === 'TT'
      ? rankTimeTrial(db, body.event_id)
      : rankHeat(db, body.event_id, body.phase, body.group_no,
                 (body.finish_order ?? []).map(String)).length;
    notify('results');
    return { ranked: n };
  });

  on('POST', '/api/progression', (q, body) => {
    const r = applyProgression(db, body.event_id, body.from_phase,
                               { regenerate: !!body.regenerate });
    notify('results');
    return r;
  });

  on('POST', '/api/official-result', (q, body) => {
    const r = compileOfficialResult(db, body.event_id);
    notify('results');
    return r;
  });

  return routes;
}

module.exports = { api };
