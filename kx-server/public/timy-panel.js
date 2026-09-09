// public/timy-panel.js — ALGE Timy3 impulse queue for the Phase page.
//
// Self-contained: include it from index.html with
//
//     <div id="timyPanel"></div>
//     <script src="/timy-panel.js"></script>
//     ...and at the end of the existing <script>:  TimyPanel.init();
//
// If timy-bridge/ is not installed, GET /api/timy/status answers
// { available: false } and init() renders nothing at all — the Phase page is
// then exactly what it is today.
//
// The panel is a QUEUE, not a display. Impulses arrive whether or not anyone
// is looking, land in timing_impulse as PENDING, and wait. Nothing reaches
// the result table until Confirm is pressed. That is deliberate: a finish
// light gate fires for paddle blades, safety boats and birds, and the cost of
// a wrong time silently entering the results is far higher than the cost of
// one keystroke per athlete.
//
// The queue spans the WHOLE competition, not the event currently open. Time
// Trials run event after event, and an impulse that arrives while the Chief
// is switching events must not be lost or attached to the wrong event.

'use strict';
const TimyPanel = (() => {

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = ms => ms == null ? '' :
    `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}` +
    `.${String(Math.floor(ms % 1000 / 10)).padStart(2, '0')}`;

  const j = (m, url, body) => fetch(url, {
    method: m, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => {
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  });

  const CSS = `
  #timyPanel { margin: .8rem 0; }
  .timy-head { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap;
    background: #f4f8fb; border: 1px solid #d6e2ec; border-radius: 6px;
    padding: .45rem .8rem; font-size: .9rem; }
  .timy-dot { width: .6rem; height: .6rem; border-radius: 50%; background: #b7c6d4; }
  .timy-dot.on { background: #256029; }
  .timy-dot.off { background: #7a2e2e; }
  .timy-imp { border: 1px solid #d6e2ec; border-left: 4px solid #256029;
    border-radius: 6px; padding: .5rem .8rem; margin-top: .45rem; background: #fff; }
  .timy-imp.flagged { border-left-color: #c58b00; background: #fffdf5; }
  .timy-imp.first { box-shadow: 0 0 0 2px #d8e5ef; }
  .timy-meta { color: #5a7286; font-size: .8rem; font-family: ui-monospace, monospace; }
  .timy-athlete { font-size: 1rem; font-weight: 600; }
  .timy-time { font-family: ui-monospace, monospace; font-size: 1.3rem; font-weight: 600; }
  .timy-why { color: #7a4f00; font-size: .85rem; margin: .2rem 0; }
  .timy-row { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; margin-top: .3rem; }
  .timy-empty { color: #5a7286; font-size: .88rem; padding: .5rem 0; }
  `;

  let competitionId = null;
  let candidates = [];          // every TT slot, in running order
  let impulses = [];
  let root = null;

  // ---------------------------------------------------------------- render
  function renderHead(st) {
    const cls = !st.running ? '' : st.connected ? 'on' : 'off';
    const where = st.port
      ? `${esc(st.port.path)} @ ${st.port.baud} baud`
      : 'no serial port open';
    const warn = st.connected ? '' :
      ' — <a href="/setup.html#timy">choose a port in Setup</a>';
    return `<div class="timy-head">
      <span class="timy-dot ${cls}"></span>
      <strong>Timy3</strong>
      <span>${st.connected ? esc(where) : 'not connected'}${st.connected ? '' : warn}</span>
      <span style="flex:1"></span>
      <span class="timy-meta">${impulses.length} waiting</span>
    </div>`;
  }

  // The dropdown lists every TT slot of the competition, grouped by event and
  // in the organiser's running order — the order the Time Trials are actually
  // paddled in. Slots that already hold a time are marked, so reassigning
  // over one is a visible decision rather than a silent overwrite.
  function candidateOptions(selectedId) {
    let lastEvent = null, html = '';
    for (const c of candidates) {
      if (c.event_code !== lastEvent) {
        if (lastEvent !== null) html += '</optgroup>';
        html += `<optgroup label="${esc(c.event_code)} — ${esc(c.event_name)}">`;
        lastEvent = c.event_code;
      }
      const taken = c.time_ms != null ? ` [has ${fmt(c.time_ms)}]` : '';
      html += `<option value="${c.result_id}" ${c.result_id === selectedId ? 'selected' : ''}>` +
        `${c.slot_no}. (${esc(c.bib)}) ${esc(c.last_name)} ${esc(c.first_name)}${taken}</option>`;
    }
    return html + (lastEvent !== null ? '</optgroup>' : '');
  }

  function renderImpulse(imp, isFirst) {
    const p = imp.proposed;
    const flagged = !imp.accepted;
    const usable = imp.run_time_ms != null;
    const how = p ? (p.matched_by === 'bib'
      ? 'matched by start number on the Timy'
      : 'next Time Trial slot without a time') : 'no athlete proposed';

    return `<div class="timy-imp ${flagged ? 'flagged' : ''} ${isFirst ? 'first' : ''}"
                 data-imp="${imp.impulse_id}">
      <div class="timy-meta">${esc(imp.channel)} · ${esc(imp.time_text)} ·
        bib ${esc(imp.bib ?? '—')} · <code>${esc(imp.raw)}</code></div>
      ${flagged ? `<div class="timy-why">⚠ ${esc(imp.reject_reason)}</div>` : ''}
      <div class="timy-row">
        <span class="timy-time">${usable ? fmt(imp.run_time_ms) : '—'}</span>
        <span class="timy-athlete">${p
          ? `(${esc(p.bib)}) ${esc(p.last_name)} ${esc(p.first_name)}`
          : '<em>choose an athlete</em>'}</span>
        <span class="timy-meta">${p ? esc(p.event_code) + ' slot ' + p.slot_no + ' · ' : ''}${how}</span>
      </div>
      <div class="timy-row">
        <select data-act="pick">${candidateOptions(p?.result_id)}</select>
        <button data-act="confirm" ${usable ? '' : 'disabled'}
          ${usable ? '' : 'title="This line carries no time that could be saved — ' +
            'there is nothing to confirm, only a record that the impulse arrived."'}>
          ${flagged ? 'Use anyway' : 'Confirm'}</button>
        <button data-act="ignore">Ignore</button>
      </div>
    </div>`;
  }

  function render(st) {
    root.innerHTML = renderHead(st) + (impulses.length
      ? impulses.map((i, n) => renderImpulse(i, n === 0)).join('')
      : `<div class="timy-empty">No impulses waiting.${st.connected
          ? ' Times appear here as athletes finish.' : ''}</div>`);

    root.querySelectorAll('.timy-imp').forEach(card => {
      const id = card.dataset.imp;
      card.querySelector('[data-act="confirm"]')?.addEventListener('click',
        () => confirmImpulse(id, card.querySelector('[data-act="pick"]').value));
      card.querySelector('[data-act="ignore"]')?.addEventListener('click',
        () => ignoreImpulse(id));
    });
  }

  // ---------------------------------------------------------------- actions
  async function confirmImpulse(impulseId, resultId) {
    const imp = impulses.find(i => i.impulse_id === impulseId);
    if (!resultId) { note('Choose which athlete this time belongs to.'); return; }
    if (!imp.accepted &&
        !confirm(`This impulse was flagged:\n\n${imp.reject_reason}\n\n` +
                 `Save ${fmt(imp.run_time_ms)} as this athlete's Time Trial time anyway?`)) return;
    const target = candidates.find(c => c.result_id === resultId);
    if (target?.time_ms != null &&
        !confirm(`That athlete already has ${fmt(target.time_ms)}. Replace it?`)) return;
    try {
      await j('POST', `/api/timy/impulses/${impulseId}/confirm`,
        { result_id: resultId, competition_id: competitionId, override: !imp.accepted });
      note('');
      await refresh();
    } catch (e) { note(e.message); }
  }

  async function ignoreImpulse(impulseId) {
    try { await j('POST', `/api/timy/impulses/${impulseId}/ignore`); await refresh(); }
    catch (e) { note(e.message); }
  }

  function note(msg) { const n = $('note'); if (n) n.textContent = msg; }

  // ---------------------------------------------------------------- data
  async function refresh() {
    const st = await j('GET', '/api/timy/status');
    if (!st.available) { root.innerHTML = ''; return; }
    const [imp, cand] = await Promise.all([
      j('GET', `/api/timy/impulses?status=PENDING&competition_id=${competitionId}`),
      j('GET', `/api/timy/candidates?competition_id=${competitionId}`),
    ]);
    impulses = imp.impulses;
    candidates = cand.candidates;
    render(st);
  }

  // ---------------------------------------------------------------- init
  async function init(opts = {}) {
    root = $(opts.container ?? 'timyPanel');
    if (!root) return;
    const st = await j('GET', '/api/timy/status').catch(() => ({ available: false }));
    if (!st.available) return;                 // bridge not installed — stay invisible

    document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
    const state = await j('GET', '/api/app-state');
    competitionId = state.active_competition_id;
    await refresh();

    // NOTE: this module does not open an EventSource. The Phase page already
    // has one, and Chrome allows only six connections per origin while an SSE
    // stream holds one for the life of the page — a second stream would spend
    // a sixth of the budget receiving messages the first already delivers.
    // The page calls TimyPanel.onNotify(ev.data) from its own handler instead.

    // Enter confirms the top card: the operator watches the athlete cross the
    // line and presses one key. Suppressed while a field is focused, where
    // Enter belongs to the Phase table's own row-advance handler.
    document.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName))) return;
      const first = impulses[0];
      if (!first || !first.accepted || first.run_time_ms == null) return;
      e.preventDefault();
      const card = root.querySelector(`.timy-imp[data-imp="${first.impulse_id}"]`);
      confirmImpulse(first.impulse_id, card?.querySelector('[data-act="pick"]')?.value);
    });
  }

  // Called from the Phase page's existing SSE handler. 'timing' fires on every
  // impulse, confirmation and connection change; 'results' matters too,
  // because a time typed by hand changes which slot is "next" and therefore
  // which athlete gets proposed. Coalesced, because a burst of reconnect
  // attempts can otherwise trigger a refresh each.
  let pending = null;
  function onNotify(topic) {
    if (topic !== 'timing' && topic !== 'results') return;
    clearTimeout(pending);
    pending = setTimeout(() => refresh().catch(e => console.error('TimyPanel', e)), 250);
  }

  return { init, refresh, onNotify };
})();
