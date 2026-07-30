// lib/leaderboard-api.js
// Leaderboard for kx-server — implements leaderboard-specification.md
//
// URL:  {server}/leaderboard          (optional: ?interval=20|30|50, default 30)
//
// Spec highlights implemented here:
//  * FullHD, no scrolling, no navigation elements, no images — text + CSS only.
//  * Automatic carousel: EVENT changes every 20/30/50 s (selectable via ?interval=).
//  * Phase columns (Q, RQ, QF, SF, F) derived from event.rule_id via
//    progression_rule_step, so every phase/heat of the progression system is
//    visible even before any athlete data exists.
//  * Time Trial start list / results rendered BELOW the phase tables.
//  * Header: competition_name + event_code - event_name (left), clock (right).
//  * Black text on white background; "OFFICIAL" green; faults red.
//  * Competition = the session-wide active competition (app_state), so the
//    page needs no picker. Live refresh via the existing SSE /api/stream.

'use strict';

const PHASE_ORDER  = ['Q', 'RQ', 'QF', 'SF', 'F'];
const PHASE_LABELS = {
  TT: 'TIME TRIAL',
  Q:  'QUALIFICATION',
  RQ: 'REPECHAGE QUALIFICATION',
  QF: 'QUARTER-FINAL',
  SF: 'SEMI-FINAL',
  F:  'FINAL'
};

module.exports = function leaderboardAPI(db) {

  // ---------------------------------------------------------------- helpers

  function getActiveCompetition() {
    const viaState = db.prepare(
      `SELECT c.* FROM app_state a
        JOIN competition c ON c.competition_id = a.active_competition_id
       WHERE a.state_key = 'active'`
    ).get();
    if (viaState) return viaState;
    // Fallback: newest competition, so the page still works before app_state is set
    return db.prepare(
      'SELECT * FROM competition ORDER BY updated_at DESC LIMIT 1'
    ).get();
  }

  // phase -> group_no -> slot count, derived from the event's progression rule.
  // This is what makes empty heats visible before results exist (spec req.).
  function buildPhaseSkeleton(ruleId) {
    const skeleton = {};
    if (!ruleId) return skeleton;
    const steps = db.prepare(
      `SELECT from_phase, from_group, from_rank, to_phase, to_group, to_slot
         FROM progression_rule_step WHERE rule_id = ?`
    ).all(ruleId);
    for (const s of steps) {
      if (s.to_phase !== 'RESULT') {
        skeleton[s.to_phase] ??= {};
        skeleton[s.to_phase][s.to_group] =
          Math.max(skeleton[s.to_phase][s.to_group] ?? 0, s.to_slot);
      }
      if (s.from_phase !== 'TT') {
        skeleton[s.from_phase] ??= {};
        skeleton[s.from_phase][s.from_group] =
          Math.max(skeleton[s.from_phase][s.from_group] ?? 0, s.from_rank);
      }
    }
    return skeleton;
  }

  function faultText(r) {
    const parts = [];
    if (r.status) parts.push(r.status);              // DNS / DNF / DSQ
    for (let g = 1; g <= 8; g++) {
      const p = r['gate' + g];
      if (p) parts.push(p + ' G' + g);               // FLT G3 / RAL G5
    }
    return parts.join(' ');
  }

  // Note: first_name_initial already contains the trailing dot in the
  // database, so no punctuation is added here.
  function displayName(r) {
    const initial = r.first_name_initial ||
                    (r.first_name ? r.first_name[0] : '');
    return (initial ? initial + ' ' : '') + (r.last_name || '');
  }

  function fmtTime(ms) {
    if (ms == null) return '';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const h = Math.floor((ms % 1000) / 10);
    return m + ':' + String(s).padStart(2, '0') + '.' + String(h).padStart(2, '0');
  }

  // Heat/TT status, derived from the result rows (schema has no explicit flag):
  //  * OFFICIAL   — every athlete has a rank or a whole-run status (DNS/DNF/DSQ),
  //                 i.e. the Chief of Scoring has completed the heat.
  //  * START LIST — athletes are assigned to slots but nothing has been scored
  //                 yet: no rank, no status, no time, no gate penalty.
  //  * '' (blank) — anything in between: the heat is in progress.
  function statusOf(rows) {
    if (!rows.length) return '';
    if (rows.every(r => r.rank != null || r.status != null)) return 'OFFICIAL';
    const untouched = r =>
      r.rank == null && r.status == null && r.time_ms == null &&
      !r.gate1 && !r.gate2 && !r.gate3 && !r.gate4 &&
      !r.gate5 && !r.gate6 && !r.gate7 && !r.gate8;
    if (rows.every(untouched)) return 'START LIST';
    return '';
  }

  // ------------------------------------------------------ payload for 1 event

  function eventPayload(event) {
    const rows = db.prepare(
      `SELECT r.phase, r.group_no, r.slot_no, r.rank, r.time_ms, r.status,
              ea.bib, ea.first_name, ea.first_name_initial, ea.last_name,
              vg.gate1, vg.gate2, vg.gate3, vg.gate4,
              vg.gate5, vg.gate6, vg.gate7, vg.gate8
         FROM result r
         LEFT JOIN event_athlete ea
                ON ea.event_id = r.event_id AND ea.athlete_id = r.athlete_id
         LEFT JOIN v_result_gates vg ON vg.result_id = r.result_id
        WHERE r.event_id = ?`
    ).all(event.event_id);

    const skeleton = buildPhaseSkeleton(event.rule_id);

    // Group result rows: phase -> group_no -> [rows]
    const byPhase = {};
    for (const r of rows) {
      if (r.phase === 'TT' || r.phase === 'RESULT') continue;
      byPhase[r.phase] ??= {};
      (byPhase[r.phase][r.group_no] ??= []).push(r);
    }

    // Phases to show = rule skeleton ∪ phases having results, in fixed order
    const phases = [];
    for (const code of PHASE_ORDER) {
      const groups = new Set([
        ...Object.keys(skeleton[code] ?? {}),
        ...Object.keys(byPhase[code] ?? {})
      ].map(Number));
      if (!groups.size) continue;

      const heats = [...groups].sort((a, b) => a - b).map(g => {
        const heatRows = (byPhase[code]?.[g] ?? [])
          .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.slot_no - b.slot_no);
        const slots = Math.max(skeleton[code]?.[g] ?? 0, heatRows.length, 4);
        const table = [];
        for (let i = 0; i < slots; i++) {
          const r = heatRows[i];
          table.push(r ? {
            rank:  r.rank,
            bib:   r.bib ?? '',
            name:  displayName(r),
            fault: faultText(r)
          } : { rank: null, bib: '', name: '', fault: '' });
        }
        return { group_no: g, status: statusOf(heatRows), rows: table };
      });

      phases.push({ code, label: PHASE_LABELS[code], heats });
    }

    // Time Trial block (below the phase tables)
    const ttRows = rows
      .filter(r => r.phase === 'TT')
      .sort((a, b) =>
        (a.rank ?? 999) - (b.rank ?? 999) || a.slot_no - b.slot_no);
    const tt = {
      status: statusOf(ttRows),
      rows: ttRows.map(r => ({
        rank: r.rank ?? r.slot_no,          // rank, or start order before results
        bib:  r.bib ?? '',
        name: displayName(r),
        time: r.status ? r.status : fmtTime(r.time_ms)
      }))
    };

    return {
      event: {
        event_id:   event.event_id,
        event_code: event.event_code,
        event_name: event.event_name
      },
      phases, tt
    };
  }

  // ---------------------------------------------------------------- routes

  return {
    'GET /leaderboard': async () => ({ html: leaderboardHTML() }),

    // No event_id -> { competition, events [] }
    // With event_id -> full payload for that event
    'GET /api/v1/leaderboard': async (q) => {
      const competition = getActiveCompetition();
      if (!competition) return { error: 'No competition found' };

      if (!q.event_id) {
        const events = db.prepare(
          `SELECT event_id, event_code, event_name, rule_id
             FROM event WHERE competition_id = ? ORDER BY event_code`
        ).all(competition.competition_id);
        return {
          competition: {
            competition_id:   competition.competition_id,
            competition_name: competition.competition_name
          },
          events
        };
      }

      const event = db.prepare(
        'SELECT * FROM event WHERE event_id = ?'
      ).get(q.event_id);
      if (!event) return { error: 'Event not found' };
      return eventPayload(event);
    }
  };
};

// =============================================================== UI (HTML)

function leaderboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Leaderboard</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<style>
  /* Spec: black text, white background, high contrast, no images, no nav,
     everything fits a 1080p screen without scrolling. */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden;
               background: #fff; color: #000;
               font-family: Arial, Helvetica, sans-serif; }
  body { display: flex; flex-direction: column; padding: 10px 16px; }

  /* ---- header: competition/event left, clock right ---- */
  #hdr { display: flex; justify-content: space-between; align-items: flex-start; }
  #comp  { font-size: clamp(14px, 2.4vh, 26px); font-weight: bold; }
  /* #event { font-size: clamp(12px, 2.0vh, 22px); } */
  #eventcode { font-size: clamp(10px, 1.8vh, 20px); width: 6ch ;padding: 0 8px; background-color: rgb(206, 123, 0); color: white; border-radius: 2px;  }
  #eventname { font-size: clamp(12px, 2.0vh, 22px); }

  #clock { font-size: clamp(40px, 6.0vh, 50px); font-weight: bold;
           font-variant-numeric: tabular-nums;
           background: #000; color: #fff;
           border-radius: 8px; padding: 2px 15px;
           line-height: 1.0; }

  /* ---- phase columns ---- */

  #phases { flex: 1 1 auto; min-height: 0; overflow: hidden;
            display: grid; gap: 14px; margin-top: 10px;
            align-items: start; }
  .phase-title { font-size: clamp(11px, 1.8vh, 18px); font-weight: bold;
                 margin-bottom: 4px; }
  .heat { margin-bottom: 8px; }
  .heat-head { font-size: clamp(10px, 1.5vh, 14px); margin-bottom: 2px; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 1px solid #000; padding: 1px 4px;
           font-size: clamp(9px, 1.45vh, 14px);
           overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  th { text-align: left; font-weight: bold; }
  col.c-rank  { width: 17%; }
  col.c-bib   { width: 15%; }
  col.c-name  { width: 46%; }
  col.c-fault { width: 22%; }

  .official  { background: #008000; color: #fff; font-weight: bold;  /* spec: green bg, white text */
               border-radius: 6px; padding: 0 8px; display: inline-block; }
  .fault     { color: #c00000; font-weight: bold; }  /* spec: red   */
  .startlist { background: #000; color: #fff; font-weight: bold;     /* spec: black bg, white text */
               border-radius: 6px; padding: 0 8px; display: inline-block; }
  .name      { font-weight: bold; }                  /* athlete names stand out */

  /* ---- Time Trial below the phase tables ---- */
  #tt { flex: 0 0 auto; margin-top: 8px; max-height: 26vh; overflow: hidden; }
  #tt-title { font-size: clamp(11px, 1.8vh, 18px); font-weight: bold; }
  #tt-list { column-count: 3; column-gap: 28px; margin-top: 4px; }
  .tt-row { font-size: clamp(9px, 1.45vh, 14px);
            font-variant-numeric: tabular-nums;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tt-row span.r { display: inline-block; width: 2.2em; }
  .tt-row span.b { display: inline-block; width: 3.2em; }
  .tt-row span.t { float: right; }

  #msg { margin-top: 20px; font-size: 18px; }
</style>
</head>
<body>
  <div id="hdr">
    <div>
      <div id="comp"></div>
      <div><span id="eventcode"></span> <span id="eventname"></span></div>
      <!-- div id="event"></div -->
    </div>
    <div id="clock"></div>
  </div>
  <div id="phases"></div>
  <div id="tt" style="display:none">
    <div id="tt-title"></div>
    <div id="tt-list"></div>
  </div>
  <div id="msg"></div>

<script>
(function () {
  'use strict';

  // Rotation interval per spec: 20 / 30 / 50 s, selectable via ?interval=
  var p  = new URLSearchParams(location.search).get('interval');
  var iv = (p === '5' || p === '20' || p === '20' || p === '30' || p === '50') ? +p : 30;

  var events = [], idx = 0, competitionName = '';

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Clock, format per spec example: "12.30.00"
  function tick() {
    var d = new Date(), z = function (n) { return String(n).padStart(2, '0'); };
    el('clock').textContent = z(d.getHours()) + '.' + z(d.getMinutes()) + '.' + z(d.getSeconds());
  }
  setInterval(tick, 1000); tick();

  function statusSpan(st) {
    if (st === 'OFFICIAL')   return ' <span class="official">OFFICIAL</span>';
    if (st === 'START LIST') return ' <span class="startlist">START LIST</span>';
    return '';
  }

  function renderEvent(data) {
    el('comp').textContent  = competitionName;
    // el('event').textContent = data.event.event_code + ' - ' + data.event.event_name;
    el('eventcode').textContent = data.event.event_code;
    el('eventname').textContent = data.event.event_name;

    var ph = el('phases');
    ph.style.gridTemplateColumns =
      'repeat(' + Math.max(data.phases.length, 1) + ', 1fr)';

    var html = '';
    data.phases.forEach(function (phase) {
      html += '<div class="phase-col">';
      html += '<div class="phase-title">' + esc(phase.label) + '</div>';
      phase.heats.forEach(function (heat) {
        html += '<div class="heat">';
        html += '<div class="heat-head">Heat ' + heat.group_no + statusSpan(heat.status) + '</div>';
        html += '<table><colgroup>' +
                '<col class="c-rank"><col class="c-bib">' +
                '<col class="c-name"><col class="c-fault"></colgroup>';
        html += '<tr><th>RANK</th><th>BIB</th><th>NAME</th><th>FAULT</th></tr>';
        heat.rows.forEach(function (r) {
          html += '<tr><td>' + (r.rank == null ? '&nbsp;' : r.rank) + '</td>' +
                  '<td>' + esc(r.bib) + '</td>' +
                  '<td class="name">' + esc(r.name) + '</td>' +
                  '<td class="fault">' + esc(r.fault) + '</td></tr>';
        });
        html += '</table></div>';
      });
      html += '</div>';
    });
    ph.innerHTML = html;

    // Time Trial below the phase tables (spec)
    if (data.tt && data.tt.rows.length) {
      el('tt').style.display = '';
      el('tt-title').innerHTML = 'TIME TRIAL' + statusSpan(data.tt.status) + ':';
      el('tt-list').innerHTML = data.tt.rows.map(function (r) {
        return '<div class="tt-row">' +
               '<span class="r">' + (r.rank == null ? '' : r.rank) + '</span>' +
               '<span class="b">(' + esc(r.bib) + ')</span> ' +
               '<span class="name">' + esc(r.name) + '</span>' +
               '<span class="t">' + esc(r.time) + '</span></div>';
      }).join('');
    } else {
      el('tt').style.display = 'none';
    }
  }

  function loadCurrent() {
    if (!events.length) return;
    fetch('/api/v1/leaderboard?event_id=' + encodeURIComponent(events[idx].event_id))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.error) renderEvent(d); })
      .catch(function () { /* keep last good view */ });
  }

  function rotate() { idx = (idx + 1) % Math.max(events.length, 1); loadCurrent(); }

  fetch('/api/v1/leaderboard')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { el('msg').textContent = d.error; return; }
      competitionName = d.competition.competition_name;
      events = d.events || [];
      if (!events.length) {
        el('comp').textContent = competitionName;
        el('msg').textContent  = 'No events in this competition.';
        return;
      }
      loadCurrent();
      if (events.length > 1) setInterval(rotate, iv * 1000);
    })
    .catch(function (e) { el('msg').textContent = 'Load failed: ' + e.message; });

  // Live refresh: re-fetch current event when the server signals a change
  try {
    var lastRefresh = 0;
    var es = new EventSource('/api/stream');
    es.onmessage = function () {
      var now = Date.now();
      if (now - lastRefresh > 1000) { lastRefresh = now; loadCurrent(); }
    };
  } catch (e) { /* SSE unavailable — carousel still refreshes on rotation */ }
})();
</script>
</body>
</html>`;
}
