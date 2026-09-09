// public/timy-setup.js — Timy3 serial port selection for the Setup page.
//
// Include after the existing Setup markup:
//
//     <h2 id="timy">1b. Timy3 Timing (optional)</h2>
//     <div id="timySetup"></div>
//     <script src="/timy-setup.js"></script>
//     ...and at the end of setup.html's <script>:  TimySetup.init();
//
// This is a MACHINE setting, not a competition setting: the port belongs to
// the computer the Timy3 is plugged into. It is therefore not stored on the
// competition — copying a competition database to another laptop must not
// carry a stale "COM3" with it.

'use strict';
const TimySetup = (() => {

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const j = (m, url, body) => fetch(url, {
    method: m, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => {
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  });

  const BAUDS = [2400, 4800, 9600, 19200, 28800, 38400];   // Timy3 menu options

  // How each classification from lib/discovery.js is presented. The operator
  // is told what was recognised and what wasn't, rather than being handed a
  // bare list of device paths to guess from.
  const BADGE = {
    timy:     ['fit',   'Timy3'],
    possible: ['nofit', 'USB-serial adapter'],
    unknown:  ['nofit', 'unidentified'],
  };

  let root = null, ports = [], status = null;

  function render() {
    // Could not reach the server at all. This is NOT evidence that the bridge
    // is missing, and must never be reported as such: the operator would go
    // and reinstall something that is already installed. Say what actually
    // happened and offer a retry.
    if (status?.unreachable) {
      root.innerHTML = `<p class="note err">Could not ask the server about the
        Timy3: ${esc(status.error ?? 'no response')}. The timing status is
        unknown — this does not mean the bridge is missing.</p>
        <button id="timyRetry" type="button">Check again</button>`;
      $('timyRetry').onclick = () => init();
      return;
    }
    // The server answered, and said the folder is not there.
    if (!status.available) {
      root.innerHTML = `<p class="hint">The <code>timy-bridge</code> folder is not
        present on this computer, so electronic timing is off and Time Trial
        times are entered by hand. To enable it, copy <code>timy-bridge/</code>
        into the server folder, run <code>npm install</code> inside it, and
        restart the server.</p>`;
      return;
    }
    // null means "not known yet" — the bridge is starting or not answering —
    // which is NOT the same as "not installed". Saying the dependency is
    // missing when it may be fine would send the operator off to reinstall
    // something that works.
    if (status.serialport_available == null) {
      root.innerHTML = `<p class="note">The Timy bridge is not answering yet.
        ${esc(status.reason ?? '')}</p>
        <button id="timyRetry" type="button">Check again</button>`;
      $('timyRetry').onclick = init;
      return;
    }
    if (!status.serialport_available) {
      root.innerHTML = `<p class="note err">The bridge source is present but its
        <code>serialport</code> dependency is not installed. Run
        <code>npm install</code> inside <code>timy-bridge/</code> and restart
        the server.</p>`;
      return;
    }

    const sel = ports.map(p => {
      const [, label] = BADGE[p.confidence] ?? ['nofit', esc(p.confidence)];
      return `<option value="${esc(p.path)}" data-confidence="${p.confidence}"
        ${status.port?.path === p.path ? 'selected' : ''}>${esc(p.label)} — ${label}</option>`;
    }).join('') || '<option value="">no serial ports found</option>';

    // Defensive on purpose: a half-populated status must degrade to a plain
    // label, never throw. This function writes the whole section in one go, so
    // an exception here leaves the operator with a blank page and no clue why.
    const conn = status.connected && status.port
      ? `<span class="badge fit">connected</span> ${esc(status.port.path)}
         at ${status.port.baud ?? '?'} baud${status.port.reason
           ? ' — ' + esc(status.port.reason) : ''}`
      : status.connected
        ? '<span class="badge fit">connected</span> (port details unavailable)'
      // The cable is out, or the device was switched off. The bridge keeps
      // retrying on its own, so tell the operator that rather than making
      // them press Connect again.
      : status.reconnecting
        ? `<span class="badge nofit">reconnecting</span>
           ${esc(status.last_port?.path ?? '')} — ${esc(status.reconnecting.reason)}.
           Attempt ${status.reconnecting.attempt}; retrying automatically.
           Plug the Timy3 back in and it will reconnect by itself.`
        : '<span class="badge nofit">not connected</span>';

    root.innerHTML = `
      <p class="hint">The Timy3 sends the finished Time Trial time over USB.
      Set the device to 9600 baud, 8 data bits, no parity, 1 stop bit, and
      handshake <code>NO RTS-CTS</code>. A port identified as an ALGE device is
      connected automatically; anything else can be opened deliberately with
      <em>Connect anyway</em> — that is how a Timy3 simulator, or a Timy3 on an
      RS232-to-USB adapter, is used.</p>

      <div class="row">
        <div><label>Serial port</label><select id="timyPort">${sel}</select></div>
        <div style="max-width:9rem"><label>Baud</label><select id="timyBaud">
          ${BAUDS.map(b => `<option ${b === (status.port?.baud ?? 9600) ? 'selected' : ''}>${b}</option>`).join('')}
        </select></div>
      </div>
      <div class="row" style="align-items:flex-end">
        <div style="flex:0">
          <button id="timyRescan" type="button">Rescan ports</button>
          <button id="timyConnect" type="button">Connect</button>
          <button id="timyForce" type="button">Connect anyway</button>
          <button id="timyDisconnect" class="secondary" type="button"
            ${status.connected ? '' : 'disabled'}>Disconnect</button>
        </div>
      </div>
      <p class="note">${conn}</p>
      <p class="hint" id="timyAuto"></p>

      <details>
        <summary>Validation thresholds</summary>
        <p class="hint">A finish light gate fires for anything that breaks the
        beam — the boat, the paddle blade a moment later, a safety kayak. These
        bounds decide what the bridge offers as a time. Nothing is discarded:
        an impulse outside them still appears on the Phase page, flagged, and
        can be used with <em>Use anyway</em>.</p>
        <div class="row">
          <div><label>Shortest plausible run (s)</label>
            <input id="timyMin" type="number" min="1" step="1"
              value="${(status.validation?.min_run_time_ms ?? 20000) / 1000}"></div>
          <div><label>Longest plausible run (s)</label>
            <input id="timyMax" type="number" min="1" step="1"
              value="${(status.validation?.max_run_time_ms ?? 300000) / 1000}"></div>
          <div><label>Repeat-impulse window (s)</label>
            <input id="timyDup" type="number" min="0" step="0.5"
              value="${(status.validation?.duplicate_window_ms ?? 3000) / 1000}"></div>
        </div>
        <div class="row">
          <div><label>What the Timy sends</label><select id="timyMode">
            <option value="run_time" ${status.mode === 'run_time' ? 'selected' : ''}>
              The finished run time (RT/TT channel)</option>
            <option value="time_of_day" ${status.mode === 'time_of_day' ? 'selected' : ''}>
              Start and finish times of day (c0/c1) — pair them here</option>
          </select></div>
        </div>
        <button id="timySaveVal" type="button">Save thresholds</button>
      </details>`;

    $('timyRescan').onclick = rescan;
    $('timyConnect').onclick = () => connect(false);
    $('timyForce').onclick = () => connect(true);
    $('timyDisconnect').onclick = async () => {
      try { status = await j('POST', '/api/timy/disconnect'); render(); }
      catch (e) { note(e.message, true); }
    };
    $('timySaveVal').onclick = saveValidation;
  }

  function note(msg, isErr) {
    root.insertAdjacentHTML('beforeend',
      `<p class="note ${isErr ? 'err' : 'ok'}">${esc(msg)}</p>`);
  }

  async function rescan() {
    try {
      const r = await j('GET', '/api/timy/ports');
      ports = r.ports;
      status = await j('GET', '/api/timy/status');
      render();
      if ($('timyAuto')) $('timyAuto').textContent = r.auto_reason ?? '';
    } catch (e) { note(e.message, true); }
  }

  // `force` is the deliberate path for an unrecognised device. Without it the
  // server refuses and explains why, which is the behaviour we want by
  // default: opening the wrong port silently times the wrong course.
  async function connect(force) {
    const path = $('timyPort').value;
    if (!path) { note('No serial port selected.', true); return; }
    const opt = $('timyPort').selectedOptions[0];
    if (force && opt.dataset.confidence !== 'timy' &&
        !confirm(`${path} is not recognised as a Timy3.\n\n` +
                 'Connect anyway? Use this for a simulator, or for a Timy3 on an ' +
                 'RS232-to-USB adapter.')) return;
    try {
      status = await j('POST', '/api/timy/connect',
        { path, baud: +$('timyBaud').value, force });
      render();
      note(`Connected to ${path}.`);
    } catch (e) {
      render();
      note(e.message, true);
    }
  }

  async function saveValidation() {
    try {
      status = await j('POST', '/api/timy/configure', {
        mode: $('timyMode').value,
        validation: {
          min_run_time_ms: Math.round(+$('timyMin').value * 1000),
          max_run_time_ms: Math.round(+$('timyMax').value * 1000),
          duplicate_window_ms: Math.round(+$('timyDup').value * 1000),
        },
      });
      render();
      note('Saved. Thresholds apply to impulses from now on.');
    } catch (e) { note(e.message, true); }
  }

  // Refresh the connection state only. Deliberately does NOT re-enumerate the
  // serial ports: that call costs a quarter of a second of server time because
  // it walks the machine's USB devices, and the list does not change while a
  // cable is being retried. This runs on every SSE notification, so it has to
  // stay cheap.
  async function refreshStatus() {
    if (!root) return;
    status = await j('GET', '/api/timy/status')
      .catch(e => ({ unreachable: true, error: e.message }));
    safeRender();
  }

  // Called by the page's own SSE handler — this module does not open a stream
  // of its own. Chrome allows six connections per origin and an EventSource
  // holds one open for the life of the page, so a second stream would spend a
  // sixth of the page's connection budget to receive messages the first one
  // already delivers.
  let pending = null;
  function onNotify(topic) {
    if (topic !== 'timing') return;
    // Coalesce: while the cable is out the bridge reports every reconnect
    // attempt, and several can land in quick succession.
    clearTimeout(pending);
    pending = setTimeout(refreshStatus, 250);
  }

  async function init(opts = {}) {
    root = $(opts.container ?? 'timySetup');
    if (!root) return;
    status = await j('GET', '/api/timy/status')
      .catch(e => ({ unreachable: true, error: e.message }));
    if (status.available && status.serialport_available === true) {
      try { ports = (await j('GET', '/api/timy/ports')).ports; } catch { ports = []; }
    }
    safeRender();
  }

  // render() writes the whole section in one assignment, so anything thrown
  // before that line leaves a blank page and no clue why. Never let it.
  function safeRender() {
    try {
      render();
    } catch (e) {
      root.innerHTML = `<p class="note err">The Timy3 section could not be
        displayed: ${esc(e.message)}. Timing is unaffected — Time Trial times
        can still be entered by hand.</p>`;
      console.error('TimySetup.render', e, status);
    }
  }

  return { init, rescan, onNotify, refreshStatus };
})();
