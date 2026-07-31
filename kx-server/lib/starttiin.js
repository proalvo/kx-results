// lib/starttiin.js — starttiin.fi start-list import for KX-Results.
//
// starttiin.fi provides a public JSON API for start lists:
//     GET https://www.starttiin.fi/api/public/races/{raceId}/starts
//     Authorization: Bearer {API-avain}
//
// Mapping to the KX-Results database (see starttiin-specification.md):
//     startLists[].name                        -> event.event_code (must exist)
//     startLists[].competitors[].startOrder    -> Time Trial slot_no
//                                                 (stored as event_athlete.list_order,
//                                                 which POST /api/phase/start-tt turns
//                                                 into TT slot_no in the same order)
//     startLists[].competitors[].competitionNumber -> event_athlete.bib
//     startLists[].competitors[].participants  -> athlete full name; the LAST space
//                                                 separates first name(s) from last name
//                                                 ("Mette Maarit Mäkinen" ->
//                                                  first "Mette Maarit", last "Mäkinen")
//     startLists[].competitors[].teamName      -> club
//     country                                  -> not provided; left empty (NULL)
//
// Flow: the browser never talks to starttiin.fi directly (CORS + keeps the
// API-avain handling in one place). POST /api/starttiin/fetch proxies the GET
// and returns a mapped, validated PREVIEW. Nothing is written until the user
// confirms with POST /api/starttiin/save, which re-validates and inserts.

'use strict';
const { uuid } = require('./db');

const STARTTIIN_BASE = 'https://www.starttiin.fi';
const FETCH_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------- name split
// Last space separates first name(s) from last name. Extra whitespace is
// collapsed first so "  Mette  Maarit  Mäkinen " still splits correctly.
function parseFullName(full) {
  const s = String(full ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return { first_name: '', last_name: '' };
  const i = s.lastIndexOf(' ');
  if (i === -1) return { first_name: '', last_name: s };   // single token = last name
  return { first_name: s.slice(0, i), last_name: s.slice(i + 1) };
}

// ------------------------------------------------------------- participants
// The spec maps "participants" to the athlete's full name. Be tolerant about
// the exact JSON shape: a plain string, an array of strings, or an array of
// objects carrying a name field. Kayak cross is a K1 discipline, so the first
// participant is the athlete.
function participantName(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  if (Array.isArray(p)) return p.length ? participantName(p[0]) : '';
  if (typeof p === 'object') {
    if (typeof p.name === 'string') return p.name;
    if (typeof p.fullName === 'string') return p.fullName;
    if (p.firstName || p.lastName) {
      return [p.firstName, p.lastName].filter(Boolean).join(' ');
    }
  }
  return '';
}

// -------------------------------------------------------------- normalising
// Turn the raw starttiin.fi response into a uniform internal structure:
//   [{ event_code, competitors: [{ start_order, bib, first_name, last_name, club }] }]
// Throws with a user-actionable message if the payload isn't what we expect.
function normalizeStartLists(json) {
  const lists = Array.isArray(json) ? json
    : Array.isArray(json?.startLists) ? json.startLists
    : Array.isArray(json?.data) ? json.data
    : null;
  if (!lists) {
    throw new Error('Unexpected response from starttiin.fi — no start lists found. ' +
      'Check the raceId.');
  }
  return lists.map((list, li) => {
    const eventCode = String(list?.name ?? '').trim();
    const competitors = (Array.isArray(list?.competitors) ? list.competitors : [])
      .map((c, ci) => {
        const { first_name, last_name } = parseFullName(participantName(c?.participants));
        return {
          start_order: c?.startOrder != null ? +c.startOrder : ci + 1,
          bib: c?.competitionNumber != null ? String(c.competitionNumber).trim() : '',
          first_name,
          last_name,
          club: String(c?.teamName ?? '').trim() || null,
        };
      })
      // TT slot order follows startOrder
      .sort((a, b) => a.start_order - b.start_order);
    if (!eventCode) {
      throw new Error(`Start list #${li + 1} from starttiin.fi has no name ` +
        '(needed as the event code).');
    }
    return { event_code: eventCode, competitors };
  });
}

// ------------------------------------------------------------------ preview
// Validate normalized lists against the database WITHOUT writing anything.
// Returns per-list info the UI renders, plus overall can_save. Blocking
// problems (per spec: the event code must exist) prevent saving entirely.
function buildPreview(db, competitionId, lists) {
  const findEvent = db.prepare(
    `SELECT event_id FROM event WHERE competition_id = ? AND event_code = ?`);
  const bibInUse = db.prepare(
    `SELECT 1 FROM event_athlete WHERE event_id = ? AND bib = ?`);
  const entryCount = db.prepare(
    `SELECT COUNT(*) AS c FROM event_athlete WHERE event_id = ?`);

  let canSave = true;
  const preview = lists.map(list => {
    const ev = findEvent.get(competitionId, list.event_code);
    const warnings = [];
    if (!ev) {
      warnings.push(`Event "${list.event_code}" does not exist in this competition — ` +
        'create it on the Setup page first. Saving is not allowed.');
      canSave = false;
    }
    if (ev && entryCount.get(ev.event_id).c > 0) {
      warnings.push(`Event "${list.event_code}" already has athletes — ` +
        'the imported list will be appended after them, and start order numbers ' +
        'from starttiin.fi will no longer equal Time Trial slots.');
    }
    const seenBibs = new Map();
    const competitors = list.competitors.map(c => {
      const rowWarnings = [];
      if (!c.bib) rowWarnings.push('Missing competition number (bib).');
      if (!c.last_name) rowWarnings.push('Missing athlete name.');
      if (c.bib) {
        if (seenBibs.has(c.bib)) {
          rowWarnings.push(`Bib "${c.bib}" appears more than once in this start list.`);
        }
        seenBibs.set(c.bib, true);
        if (ev && bibInUse.get(ev.event_id, c.bib)) {
          rowWarnings.push(`Bib "${c.bib}" is already in use in event ${list.event_code}.`);
        }
      }
      if (rowWarnings.length) canSave = false;
      return { ...c, warnings: rowWarnings };
    });
    return { event_code: list.event_code, event_exists: !!ev, warnings, competitors };
  });
  return { start_lists: preview, can_save: canSave };
}

// --------------------------------------------------------------------- save
// Insert the previewed lists. Everything is re-validated here (the preview is
// advisory; the browser payload is not trusted), and the whole save is one
// transaction — either every list goes in, or nothing does.
function saveStartLists(db, competitionId, lists) {
  const { can_save, start_lists } = buildPreview(db, competitionId, lists);
  if (!can_save) {
    const msgs = [];
    for (const l of start_lists) {
      msgs.push(...l.warnings);
      for (const c of l.competitors) {
        msgs.push(...c.warnings.map(w => `${l.event_code} / start ${c.start_order}: ${w}`));
      }
    }
    throw new Error('Cannot save:\n' + msgs.join('\n'));
  }

  const findEvent = db.prepare(
    `SELECT event_id FROM event WHERE competition_id = ? AND event_code = ?`);
  const findAthlete = db.prepare(   // reuse master record on re-import: exact
    `SELECT athlete_id FROM athlete  -- name + club match (starttiin has no IDs)
      WHERE first_name = ? AND last_name = ? AND club IS ?
      LIMIT 1`);
  const alreadyEntered = db.prepare(
    `SELECT 1 FROM event_athlete WHERE event_id = ? AND athlete_id = ?`);
  const maxListOrder = db.prepare(
    `SELECT COALESCE(MAX(list_order), 0) AS m FROM event_athlete WHERE event_id = ?`);

  let added = 0;
  db.exec('BEGIN');
  try {
    for (const list of lists) {
      const ev = findEvent.get(competitionId, list.event_code);
      // If the event is empty, list_order = startOrder exactly, so
      // POST /api/phase/start-tt yields TT slot_no in starttiin.fi order.
      // If it already has entries, append after the existing list.
      const offset = maxListOrder.get(ev.event_id).m;
      for (const c of list.competitors) {
        let athleteId = findAthlete.get(c.first_name, c.last_name, c.club)?.athlete_id;
        if (athleteId && alreadyEntered.get(ev.event_id, athleteId)) {
          throw new Error(`${list.event_code}: ${c.first_name} ${c.last_name} ` +
            'is already entered in this event.');
        }
        if (!athleteId) {
          athleteId = uuid();
          db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, club, country)
                      VALUES (?, ?, ?, ?, NULL)`)
            .run(athleteId, c.first_name, c.last_name, c.club);
        }
        db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
                      first_name, first_name_initial, last_name, club, country)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
          .run(ev.event_id, athleteId, c.bib, offset + c.start_order,
               c.first_name, c.first_name ? c.first_name[0] + '.' : null,
               c.last_name, c.club);
        added++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { added };
}

// -------------------------------------------------------------------- fetch
async function fetchStartLists(raceId, apiKey, fetchImpl = fetch, baseUrl = STARTTIIN_BASE) {
  if (!raceId?.trim()) throw new Error('raceId is required.');
  if (!apiKey?.trim()) throw new Error('API-avain is required.');
  const url = `${baseUrl}/api/public/races/${encodeURIComponent(raceId.trim())}/starts`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(`Could not reach starttiin.fi: ${e.name === 'AbortError'
      ? 'request timed out' : e.message}`);
  } finally { clearTimeout(timer); }
  if (res.status === 401 || res.status === 403) {
    throw new Error('starttiin.fi rejected the API-avain (HTTP ' + res.status + ').');
  }
  if (res.status === 404) {
    throw new Error(`starttiin.fi does not know race "${raceId}" (HTTP 404).`);
  }
  if (!res.ok) {
    throw new Error(`starttiin.fi returned HTTP ${res.status}.`);
  }
  return res.json();
}

// ------------------------------------------------------------------- routes
// Merged into the server's route table (see server.js). fetchImpl is
// injectable so tests can mock the network.
function attachStarttiin(db, routes, notify, fetchImpl = fetch) {
  // Step 1: fetch from starttiin.fi and return a mapped preview. Read-only.
  routes['POST /api/starttiin/fetch'] = async (q, body) => {
    const json = await fetchStartLists(body.raceId, body.apiKey, fetchImpl);
    const lists = normalizeStartLists(json);
    const preview = buildPreview(db, body.competition_id, lists);
    // Echo the normalized lists back — the browser returns them unchanged
    // to /save after the user confirms (and /save re-validates everything).
    return { ...preview, lists };
  };

  // Step 2: user pressed Save — validate again and write.
  routes['POST /api/starttiin/save'] = (q, body) => {
    if (!Array.isArray(body.lists) || !body.lists.length) {
      throw new Error('Nothing to save — fetch a start list first.');
    }
    const r = saveStartLists(db, body.competition_id, body.lists);
    notify('athletes');
    notify('events');           // athlete counts on the Setup page
    return r;
  };
}

module.exports = {
  parseFullName, participantName, normalizeStartLists,
  buildPreview, saveStartLists, fetchStartLists, attachStarttiin,
  STARTTIIN_BASE,
};
