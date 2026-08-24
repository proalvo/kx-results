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
const { computeTTResultTimeMs, splitTimingEnabled, continuousClockEnabled,
        ttStartOffsetMs, ttPriorSlotsByEvent } = require('./tt-timing');
const { buildCompetitionResults } = require('./competition-results');

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

  // ======================================================================
  // Split-time TT timing (see lib/tt-timing.js)
  // ======================================================================
  // Under the default per-event clock an athlete's start offset depends on
  // nothing but their own slot, so a row's derived time can be worked out
  // from the row alone. Under a continuous clock it also depends on how
  // many athletes ran BEFORE their event — which makes it a property of the
  // whole competition, and means it can go stale when something entirely
  // elsewhere changes. The two helpers below are the single place that
  // knows this, and everything that can move the arithmetic calls into them.

  /**
   * Everything needed to compute start offsets for one competition:
   * the competition row, plus prior-slot counts per event.
   *
   * An event's slot count is MAX(slot_no) over its TT rows rather than
   * COUNT(*): if a starter was entered into the schedule and later scratched,
   * the clock still ran through their slot, so the events behind them must
   * not all slide one interval earlier.
   *
   * With the clock restarted per event (the default) every event's prior
   * count is 0, and the whole thing collapses back to the original
   * slot-only arithmetic.
   */
  function ttClockContext(competitionId) {
    const comp = db.prepare('SELECT * FROM competition WHERE competition_id = ?')
      .get(competitionId);
    if (!splitTimingEnabled(comp)) return null;
    if (!continuousClockEnabled(comp)) return { comp, priorSlots: new Map() };
    const eventsInOrder = db.prepare(
      `SELECT e.event_id,
              COALESCE((SELECT MAX(r.slot_no) FROM result r
                         WHERE r.event_id = e.event_id AND r.phase = 'TT'), 0) AS slot_count
         FROM event e
        WHERE e.competition_id = ?
        ORDER BY e.sort_order, e.event_code`).all(competitionId);
    return { comp, priorSlots: ttPriorSlotsByEvent(eventsInOrder) };
  }

  /**
   * Recalculate time_ms from the stored raw split readings for every TT row
   * in a competition.
   *
   * A single row is handled by PATCH /api/result when its own split or slot
   * changes. This covers the other direction — changes that move the
   * arithmetic for rows nobody is editing: the split-timing settings, the
   * event running order, and (under a continuous clock) the start lists of
   * earlier events, since those decide how far into the session each later
   * event begins.
   *
   * split_time_ms — the raw stopwatch reading, the actual observation — is
   * never touched. Only the derived time_ms is rewritten, and rows with no
   * split reading are left alone, including TT times typed in directly
   * before the feature was switched on.
   *
   * Rows whose split can no longer be reconciled with the offsets (the
   * athlete would have finished before their own start) are handled one of
   * two ways:
   *
   *   strict: true  — throw, naming them, and let the caller roll back. Used
   *     for the settings themselves, where the Chief typed the numbers that
   *     caused it and can simply type different ones.
   *   strict: false — clear time_ms and report them back. Used for
   *     structural changes such as creating a start list, where refusing
   *     would trap the Chief: they cannot fix an ordering problem without
   *     being allowed to build the start list that fixes it. A blank Time
   *     next to a preserved Split is visibly unfinished; a wrong Time is not.
   */
  function recomputeTTTimes(competitionId, { strict = false } = {}) {
    const ctx = ttClockContext(competitionId);
    if (!ctx) return { recomputed: 0, unresolved: [] };
    const { comp, priorSlots } = ctx;

    const rows = db.prepare(
      `SELECT r.result_id, r.event_id, r.slot_no, r.split_time_ms,
              e.event_code, ea.bib
         FROM result r
         JOIN event e ON e.event_id = r.event_id
         LEFT JOIN event_athlete ea
                ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
        WHERE e.competition_id = ? AND r.phase = 'TT' AND r.split_time_ms IS NOT NULL`)
      .all(competitionId);

    const set = db.prepare('UPDATE result SET time_ms = ? WHERE result_id = ?');
    const unresolved = [];
    let recomputed = 0;
    for (const r of rows) {
      try {
        set.run(computeTTResultTimeMs(
          r.split_time_ms, r.slot_no, comp.tt_start_interval_ms,
          comp.tt_time_shift_ms, priorSlots.get(r.event_id) ?? 0), r.result_id);
        recomputed++;
      } catch {
        unresolved.push(`${r.event_code} bib ${r.bib ?? '?'} (slot ${r.slot_no})`);
        if (!strict) set.run(null, r.result_id);
      }
    }
    if (strict && unresolved.length) {
      throw new Error(
        `These settings would have ${unresolved.length} athlete(s) finishing before ` +
        `their own start: ${unresolved.slice(0, 5).join(', ')}` +
        `${unresolved.length > 5 ? `, and ${unresolved.length - 5} more` : ''}. ` +
        `Nothing was changed — check the start interval, the time shift, and whether ` +
        `the split times on file were read off the clock you are describing.`);
    }
    return { recomputed, unresolved };
  }

  /**
   * Recompute after a structural change (running order, start lists, slots).
   * A no-op unless the competition runs a continuous clock, since that is
   * the only mode in which one event's start list affects another's times.
   * Returns a short human-readable warning, or null when all is well, for
   * endpoints to pass back to the page that made the change.
   */
  function recomputeAfterStructuralChange(competitionId) {
    if (!competitionId) return null;
    const comp = db.prepare('SELECT * FROM competition WHERE competition_id = ?')
      .get(competitionId);
    if (!continuousClockEnabled(comp)) return null;
    const { unresolved } = recomputeTTTimes(competitionId);
    if (!unresolved.length) return null;
    return `${unresolved.length} Time Trial time(s) could not be recalculated on the ` +
      `shared clock and have been cleared — their split readings are still on file. ` +
      `Affected: ${unresolved.slice(0, 5).join(', ')}` +
      `${unresolved.length > 5 ? `, and ${unresolved.length - 5} more` : ''}.`;
  }

  const competitionIdOfEvent = eventId => db.prepare(
    'SELECT competition_id FROM event WHERE event_id = ?').get(eventId)?.competition_id ?? null;

  // Where one event sits on the shared stopwatch. The Phase page and the
  // Gate Judge finish line both show a Split column that looks identical
  // whatever the settings, so the number that makes a reading verifiable —
  // the clock reading at which THIS event's slot 1 goes — is served rather
  // than left for the Chief to work out from the athlete counts by hand.
  on('GET', '/api/tt-clock', q => {
    const compId = competitionIdOfEvent(q.event_id);
    if (!compId) throw new Error('Unknown event_id');
    const ctx = ttClockContext(compId);
    if (!ctx) return { enabled: false };
    const priorSlots = ctx.priorSlots.get(q.event_id) ?? 0;
    return {
      enabled: true,
      continuous_clock: continuousClockEnabled(ctx.comp),
      start_interval_ms: ctx.comp.tt_start_interval_ms,
      time_shift_ms: ctx.comp.tt_time_shift_ms,
      prior_slots: priorSlots,
      // Clock reading at this event's slot 1 — the time shift for the first
      // event of a continuous session, later for the ones behind it.
      first_slot_offset_ms: ttStartOffsetMs(
        1, ctx.comp.tt_start_interval_ms, ctx.comp.tt_time_shift_ms, priorSlots),
    };
  });

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
      'location', 'type', 'tt_start_interval_ms', 'tt_time_shift_ms',
      'tt_continuous_clock', 'banner_url'];
    const sets = allowed.filter(k => k in body);
    if (!sets.length) throw new Error('Nothing to update');
    // The browser sends this one as a checkbox true/false; SQLite wants 0/1.
    const value = k => k === 'tt_continuous_clock' ? (body[k] ? 1 : 0) : body[k];
    // Any split-timing setting changes the arithmetic behind every TT time
    // already derived from a split reading, so the update and the
    // recomputation share one transaction: settings that can't be reconciled
    // with the splits on file don't get saved either, and the Chief is told
    // why instead of being left with a half-applied change.
    const touchesTiming = sets.some(k => k.startsWith('tt_'));
    if (touchesTiming) db.exec('BEGIN');
    try {
      db.prepare(`UPDATE competition SET ${sets.map(k => `${k} = ?`).join(', ')}
                  WHERE competition_id = ?`)
        .run(...sets.map(value), body.competition_id);
      if (touchesTiming) {
        recomputeTTTimes(body.competition_id, { strict: true });
        db.exec('COMMIT');
      }
    } catch (e) {
      if (touchesTiming) db.exec('ROLLBACK');
      throw friendlyError(e);
    }
    notify('competitions');
    if (touchesTiming) notify('results');
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
  // Ordered by the organiser's running order (event.sort_order), with
  // event_code as the tie-break so a competition that has never been
  // reordered still lists alphabetically exactly as it did before.
  // EVERY consumer of this endpoint inherits the order for free: the Phase
  // page's event picker, the Setup tables, the Gate Judge event list and
  // both streaming control pages.
  on('GET', '/api/events', q =>
    db.prepare(`SELECT e.*, pr.rule_name, pr.min_athletes, pr.max_athletes,
                (SELECT COUNT(*) FROM event_athlete ea WHERE ea.event_id = e.event_id) AS athlete_count
                FROM event e
                LEFT JOIN progression_rule pr ON pr.rule_id = e.rule_id
                WHERE e.competition_id = ?
                ORDER BY e.sort_order, e.event_code`).all(q.competition_id));

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
    // A new event goes to the END of the running order unless the caller
    // says otherwise. Appending (rather than defaulting to 0) means the
    // order the Chief sees is the order events were created in, which is
    // the sane starting point to then adjust — a 0 would silently jump
    // every new event to the top of an already-arranged schedule.
    const sortOrder = body.sort_order ?? (db.prepare(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM event WHERE competition_id = ?`
    ).get(body.competition_id).n);
    try {
      db.prepare(
        `INSERT INTO event (event_id, competition_id, event_code, event_name,
           gates, rule_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, body.competition_id, body.event_code, body.event_name,
            body.gates, body.rule_id ?? null, sortOrder);
    } catch (e) { throw friendlyError(e); }
    // An appended event sits at the end of the shared clock and disturbs
    // nothing. One inserted ahead of others (explicit sort_order, or an
    // event_code that sorts early against a tie) pushes them later into the
    // session — but only once it has a start list, so this is normally a
    // no-op and is here to keep the invariant rather than to do work.
    const warning = recomputeAfterStructuralChange(body.competition_id);
    notify('events');
    return { event_id: id, sort_order: sortOrder, warning };
  });

  on('PATCH', '/api/events', (q, body) => {
    // current_phase/current_group is the "active heat" pointer: the Phase
    // page sets it when the Chief starts judging a heat, and Gate Judge
    // pages read it (via GET /api/events, below) to know what to show
    // without any manual navigation on the judge's phone.
    const allowed = ['event_code', 'event_name', 'gates', 'rule_id',
      'current_phase', 'current_group', 'live_tracking', 'sort_order'];
    const sets = allowed.filter(k => k in body);
    if (!sets.length) throw new Error('Nothing to update');
    // sort_order and event_code together define the running order, which on
    // a continuous clock decides how far into the session each event starts.
    // The rest of these fields — gates, rule, the live-heat pointer — leave
    // the schedule alone and skip the extra work entirely.
    const movesOrder = sets.includes('sort_order') || sets.includes('event_code');
    let warning = null;
    if (movesOrder) db.exec('BEGIN');
    try {
      db.prepare(`UPDATE event SET ${sets.map(k => `${k} = ?`).join(', ')}
                  WHERE event_id = ?`)
        .run(...sets.map(k => body[k]), body.event_id);
      if (movesOrder) {
        warning = recomputeAfterStructuralChange(competitionIdOfEvent(body.event_id));
        db.exec('COMMIT');
      }
    } catch (e) {
      if (movesOrder) db.exec('ROLLBACK');
      throw friendlyError(e);
    }
    notify('events');
    if (movesOrder) notify('results');
    return { ok: true, warning };
  });

  // Set the running order of a competition's events in one shot.
  //   body: { competition_id, event_ids: [...] }  -> renumbered 1..N
  //
  // Takes the whole ordered list rather than a "move this one up" delta:
  // the result is then idempotent and independent of what the client
  // believed the previous order was, so two people rearranging the schedule
  // in two browser tabs can't interleave into a half-applied order. It also
  // means the UI can grow drag-and-drop later without touching the server.
  //
  // Events of the competition that the caller didn't list (someone created
  // one in another tab since this page loaded) are not dropped or left
  // dangling — they keep their relative order and are appended after the
  // listed ones, so a stale client can't destroy an event's position.
  on('POST', '/api/events/reorder', (q, body) => {
    if (!body.competition_id) throw new Error('competition_id is required');
    if (!Array.isArray(body.event_ids)) throw new Error('event_ids must be an array');

    const current = db.prepare(
      `SELECT event_id FROM event WHERE competition_id = ?
        ORDER BY sort_order, event_code`).all(body.competition_id);
    const known = new Set(current.map(e => e.event_id));

    const seen = new Set();
    for (const id of body.event_ids) {
      if (!known.has(id)) {
        throw new Error(`Event ${id} does not belong to this competition.`);
      }
      if (seen.has(id)) throw new Error(`Event ${id} is listed twice.`);
      seen.add(id);
    }
    // Anything the client didn't know about keeps its relative order, last.
    const ordered = [...body.event_ids, ...current.map(e => e.event_id).filter(id => !seen.has(id))];

    const set = db.prepare('UPDATE event SET sort_order = ? WHERE event_id = ?');
    let warning = null;
    db.exec('BEGIN');
    try {
      ordered.forEach((id, i) => set.run(i + 1, id));
      // On a continuous clock the running order IS the schedule: moving an
      // event changes how many athletes ran before it, and so every start
      // offset inside it. Recomputed in the same transaction as the reorder.
      warning = recomputeAfterStructuralChange(body.competition_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    notify('events');
    notify('results');
    return { ok: true, ordered, warning };
  });

  on('DELETE', '/api/events', (q, body) => {
    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM event_athlete WHERE event_id = ?`).get(body.event_id).c;
    if (count > 0) {
      throw new Error(
        `Cannot delete this event — it has ${count} athlete(s) uploaded. ` +
        `Remove them individually first, or don't delete the event.`);
    }
    const compId = competitionIdOfEvent(body.event_id);
    db.prepare('DELETE FROM event WHERE event_id = ?').run(body.event_id);
    // The deleted event had no athletes (guarded above) and so no slots of
    // its own, but removing it still closes a gap in the running order for
    // everything behind it.
    const warning = recomputeAfterStructuralChange(compId);
    notify('events');
    notify('results');
    return { ok: true, warning };
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
        // Check for duplicate bib in this event (give a helpful error)
        const existing = db.prepare(
          `SELECT athlete_id FROM event_athlete WHERE event_id = ? AND bib = ?`
        ).get(ev.event_id, bib);
        if (existing) {
          errors.push(`Line ${i + 2}: bib "${bib}" is already in use in event ${evCode}`);
          continue;
        }
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

  // PDF branding: header and footer images (optional, PNG/JPG)
  // Note: These handle multipart/form-data with file upload.
  // In a real production server with express/multer, this would be:
  //   app.post('/api/competition/:id/pdf-header', multer().single('image'), (req,res) => {...})
  // For now, we accept base64-encoded images in the body to keep it simple.
  on('POST', '/api/competition/:id/pdf-header', (q, body) => {
    const comp = db.prepare('SELECT competition_id FROM competition WHERE competition_id = ?').get(q.id);
    if (!comp) throw new Error('Competition not found');
    if (!body.image || !body.filename) throw new Error('Missing image data or filename');
    // body.image is expected to be base64-encoded already (from form-data conversion)
    const buffer = Buffer.from(body.image, 'base64');
    if (buffer.length > 1024*1024) throw new Error('Image must be ≤ 1 MB');
    db.prepare(`UPDATE competition SET pdf_header_image = ?, pdf_header_filename = ? WHERE competition_id = ?`)
      .run(buffer, body.filename, q.id);
    notify('competitions');
    return { ok: true };
  });

  on('DELETE', '/api/competition/:id/pdf-header', (q) => {
    const comp = db.prepare('SELECT competition_id FROM competition WHERE competition_id = ?').get(q.id);
    if (!comp) throw new Error('Competition not found');
    db.prepare(`UPDATE competition SET pdf_header_image = NULL, pdf_header_filename = NULL WHERE competition_id = ?`)
      .run(q.id);
    notify('competitions');
    return { ok: true };
  });

  on('POST', '/api/competition/:id/pdf-footer', (q, body) => {
    const comp = db.prepare('SELECT competition_id FROM competition WHERE competition_id = ?').get(q.id);
    if (!comp) throw new Error('Competition not found');
    if (!body.image || !body.filename) throw new Error('Missing image data or filename');
    const buffer = Buffer.from(body.image, 'base64');
    if (buffer.length > 1024*1024) throw new Error('Image must be ≤ 1 MB');
    db.prepare(`UPDATE competition SET pdf_footer_image = ?, pdf_footer_filename = ? WHERE competition_id = ?`)
      .run(buffer, body.filename, q.id);
    notify('competitions');
    return { ok: true };
  });

  on('DELETE', '/api/competition/:id/pdf-footer', (q) => {
    const comp = db.prepare('SELECT competition_id FROM competition WHERE competition_id = ?').get(q.id);
    if (!comp) throw new Error('Competition not found');
    db.prepare(`UPDATE competition SET pdf_footer_image = NULL, pdf_footer_filename = NULL WHERE competition_id = ?`)
      .run(q.id);
    notify('competitions');
    return { ok: true };
  });

  // Read side of the PDF branding above, for the print pages.
  //
  // Returned as data: URLs rather than as image responses because server.js
  // sends every route's return value through JSON.stringify — a binary body
  // would need a change there. Uploads are capped at 1 MB (see the POST
  // routes above), so the base64 inflation is bounded and a sheet's branding
  // arrives in a single fetch.
  // SVG is worth accepting here specifically because these images end up in
  // a PDF: vector art has no resolution to get wrong and stays sharp at any
  // zoom, for a fraction of the bytes of a 4x raster. Served from a data:
  // URL inside an <img>, so it cannot pull in external resources or run
  // script — the same sandbox any uploaded raster gets.
  const mimeOf = (filename) => {
    const name = filename ?? '';
    if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
    if (/\.svg$/i.test(name)) return 'image/svg+xml';
    return 'image/png';
  };

  on('GET', '/api/competition/:id/pdf-branding', q => {
    const row = db.prepare(
      `SELECT pdf_header_image, pdf_header_filename,
              pdf_footer_image, pdf_footer_filename
         FROM competition WHERE competition_id = ?`).get(q.id);
    if (!row) throw new Error('Competition not found');
    const asDataUrl = (buf, name) => buf
      ? `data:${mimeOf(name)};base64,${Buffer.from(buf).toString('base64')}`
      : null;
    return {
      header: asDataUrl(row.pdf_header_image, row.pdf_header_filename),
      header_filename: row.pdf_header_filename ?? null,
      footer: asDataUrl(row.pdf_footer_image, row.pdf_footer_filename),
      footer_filename: row.pdf_footer_filename ?? null,
    };
  });

  // ------------------------------------------- overall competition results
  // Every event of a competition with its final classification, for the
  // printable overall results sheet (public/print-competition.html). The
  // Phase page's print.html covers one heat at a time; this is the document
  // handed to the jury and pinned to the notice board at the end of the day.
  //
  // Read-only: it reports the official classification the Chief has already
  // compiled with "Compile Official Result", and falls back to a clearly
  // flagged provisional order for events that are unfinished.
  //   event_ids            optional, comma-separated — print a subset
  //   include_provisional  '0' to leave unfinished events unclassified
  on('GET', '/api/competition-results', q => {
    if (!q.competition_id) throw new Error('competition_id is required');
    return buildCompetitionResults(db, q.competition_id, {
      eventIds: q.event_ids ? String(q.event_ids).split(',').filter(Boolean) : undefined,
      includeProvisional: q.include_provisional !== '0',
    });
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
    // Dropping the placeholder TT row can shrink this event's slot span,
    // which on a continuous clock pulls every later event earlier.
    const warning = recomputeAfterStructuralChange(competitionIdOfEvent(body.event_id));
    notify('athletes');
    notify('results');
    return { ok: true, warning };
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
    // On a continuous clock this event's size decides where every event
    // behind it starts, so building its start list moves their offsets.
    // Notably this is what happens when the Chief builds the start lists
    // out of order — event 2's times, entered first, are corrected the
    // moment event 1's list exists.
    const warning = recomputeAfterStructuralChange(competitionIdOfEvent(body.event_id));
    notify('results');
    return { created: entries.length, warning };
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
          `SELECT r.result_id, r.phase, r.slot_no, r.split_time_ms, r.event_id,
                  e.competition_id
             FROM result r
             JOIN event e ON e.event_id = r.event_id
            WHERE r.result_id = ?`).get(body.result_id);
        // Editing a slot number can change the event's highest slot, which
        // on a continuous clock moves every event behind it — so a slot
        // edit recomputes the whole competition, while the far more common
        // split-time entry stays a single-row update and keeps the Phase
        // page's in-place, focus-preserving refresh.
        if (row && sets.includes('slot_no')
            && continuousClockEnabled(
                 db.prepare('SELECT * FROM competition WHERE competition_id = ?')
                   .get(row.competition_id))) {
          recomputeTTTimes(row.competition_id);
        } else if (row && row.phase === 'TT' && row.split_time_ms != null) {
          const ctx = ttClockContext(row.competition_id);
          if (ctx) {
            const timeMs = computeTTResultTimeMs(
              row.split_time_ms, row.slot_no, ctx.comp.tt_start_interval_ms,
              ctx.comp.tt_time_shift_ms, ctx.priorSlots.get(row.event_id) ?? 0);
            db.prepare('UPDATE result SET time_ms = ? WHERE result_id = ?')
              .run(timeMs, body.result_id);
          }
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
    const warning = body.phase === 'TT'
      ? recomputeAfterStructuralChange(competitionIdOfEvent(body.event_id)) : null;
    notify('results');
    return { result_id: id, warning };
  });

  on('DELETE', '/api/result', (q, body) => {        // manual remove
    const row = db.prepare(`SELECT event_id, phase FROM result WHERE result_id = ?`)
      .get(body.result_id);
    db.prepare('DELETE FROM result WHERE result_id = ?').run(body.result_id);
    // Removing a TT row can shrink the event's slot span, pulling every
    // event behind it earlier on the shared clock.
    const warning = row?.phase === 'TT'
      ? recomputeAfterStructuralChange(competitionIdOfEvent(row.event_id)) : null;
    notify('results');
    return { ok: true, warning };
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



