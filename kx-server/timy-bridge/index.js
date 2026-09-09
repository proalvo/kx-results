// timy-bridge/index.js — optional child process that reads an ALGE Timy3.
//
// kx-server forks this file when the timy-bridge folder exists (see
// lib/timy-wire.js). It owns the serial port and nothing else: no database,
// no HTTP, no competition logic. If it crashes, the results server keeps
// running and simply restarts it.
//
// Protocol — newline-free JSON objects over Node IPC.
//
//   parent -> child
//     { id, cmd: 'list-ports' }
//     { id, cmd: 'auto-connect' }                     scan, connect if a Timy is found
//     { id, cmd: 'connect', path, baud?, force? }     force: connect to an
//                                                     unrecognised port anyway
//     { id, cmd: 'disconnect' }
//     { id, cmd: 'configure', validation: {...}, mode: 'run_time'|'time_of_day' }
//     { id, cmd: 'status' }
//
//   child -> parent
//     { id, ok: true, ... }                 reply to a command
//     { id, ok: false, error, code }        reply to a failed command
//     { event: 'status', ... }              connection state changed
//     { event: 'impulse', impulse: {...} }  a timing line arrived
//     { event: 'log', level, message }
//
// Every impulse is forwarded, accepted or not. Filtering happens here;
// deciding what it means happens in kx-server; writing to the database
// happens only when the Chief of Scoring confirms it.
//
// Standalone use (no parent): `node index.js --list` or
// `node index.js --port COM3` prints the same messages as JSON lines, which
// is how you check a Timy or a simulator without starting kx-server.

'use strict';
const { parseTimyLine } = require('./lib/protocol');
const { listPorts, pickAutoConnect } = require('./lib/discovery');
const { createValidator } = require('./lib/validate');
const { TimyConnection, loadSerialPort, DEFAULT_BAUD } = require('./lib/serial');
const config = require('./lib/config');

const standalone = typeof process.send !== 'function';

function send(msg) {
  if (standalone) console.log(JSON.stringify(msg));
  else process.send(msg);
}

const emit = (event, payload = {}) => send({ event, ...payload });
const log = (level, message) => emit('log', { level, message });

// --------------------------------------------------------------- state
let settings = config.load();    // machine-local: port, serial number, baud, mode
let validator = createValidator({ mode: settings.mode });
let connection = new TimyConnection();
let connectedTo = null;          // { path, baud, confidence, reason }
let reconnecting = null;         // { attempt, delay_ms, reason } while retrying
let sequence = 0;                // per-session impulse counter, for ordering

function status() {
  return {
    // Both are derived from the same fact. Reporting connected:true without a
    // port is what the UI cannot render, so make that state unrepresentable.
    connected: connection.connected && !!connectedTo,
    port: connection.connected ? connectedTo : null,
    // Set while the cable is out. The port is genuinely not connected, but
    // this is a different situation from "never connected" and the operator
    // should see which one they are in.
    reconnecting,
    last_port: connectedTo,
    saved: { port: settings.port, serial_number: settings.serial_number,
             baud: settings.baud, config_path: config.CONFIG_PATH },
    mode: validator.mode,
    validation: validator.config,
    serialport_available: (() => {
      try { loadSerialPort(); return true; } catch { return false; }
    })(),
  };
}

// ----------------------------------------------------------- impulses
connection.on('line', line => {
  const parsed = parseTimyLine(line);
  if (!parsed) { log('debug', `ignored non-timing line: ${line}`); return; }

  const v = validator.validate(parsed);
  if (v.pending) { log('debug', `start impulse held for bib ${parsed.bib}`); return; }

  emit('impulse', {
    impulse: {
      seq: ++sequence,
      received_at: new Date().toISOString(),
      raw: parsed.raw,
      info: parsed.info,
      info_meaning: parsed.info_meaning,
      bib: parsed.bib,
      channel: parsed.channel,
      kind: parsed.kind,
      time_text: parsed.time_text,
      // The Time Trial time in ms. Null when the impulse was rejected —
      // kx-server shows the raw line but has nothing to offer as a result.
      run_time_ms: v.run_time_ms,
      accepted: v.accepted,
      reject_code: v.code,
      reject_reason: v.message,
    },
  });
});

connection.on('open', ({ path, baud }) => {
  reconnecting = null;
  log('info', `connected to ${path} at ${baud} baud`);
  emit('status', status());
});
connection.on('close', reason => {
  log('warn', `serial port closed: ${reason}`);
  emit('status', status());
});
connection.on('error', err => log('error', err.message));
connection.on('reconnecting', info => {
  reconnecting = info;
  log('warn', `${info.reason} — reconnect attempt ${info.attempt} in ${info.delay_ms} ms`);
  emit('status', status());
});

// ----------------------------------------------------------- commands
async function doListPorts() {
  const SerialPort = loadSerialPort();
  const ports = await listPorts(SerialPort);
  const auto = pickAutoConnect(ports);
  return { ports, auto_connect_path: auto.port?.path ?? null, auto_reason: auto.reason };
}

async function doConnect({ path, baud = DEFAULT_BAUD, force = false, remember = true }) {
  const { ports } = await doListPorts();
  const found = ports.find(p => p.path === path);
  if (!found) throw Object.assign(new Error(`No serial port named ${path}.`), { code: 'NO_PORT' });

  // An unrecognised port is connectable, but only deliberately: this is the
  // "it might be a simulator" path, and the caller has to say so.
  if (found.confidence !== 'timy' && !force) {
    throw Object.assign(
      new Error(`${path} is not recognised as a Timy3 (${found.reason}). ` +
                'Connect anyway to use it — for example a Timy3 simulator.'),
      { code: 'NOT_RECOGNISED', port: found });
  }

  // Set this BEFORE opening. connection.open() emits 'open' while it is still
  // awaited, and that handler broadcasts a status snapshot — if connectedTo
  // were still null at that moment, the parent would cache
  // { connected: true, port: null } and serve it until the next status event.
  connectedTo = { path, baud, confidence: found.confidence, reason: found.reason };
  try {
    await connection.open(path, baud);
  } catch (e) {
    connectedTo = null;                  // never leave a phantom connection
    emit('status', status());
    throw e;
  }
  validator.reset();

  // Remember the choice on THIS computer. The serial number is stored too, so
  // the device is still found after Windows renumbers the COM port.
  if (remember) {
    settings = config.save({ port: path, serial_number: found.serial_number, baud });
  }
  return status();
}

async function doAutoConnect() {
  const { ports, auto_reason } = await doListPorts();
  const { port, reason } = pickAutoConnect(ports);
  if (!port) return { connected: false, ports, reason: reason || auto_reason };
  await doConnect({ path: port.path });
  return { connected: true, ports, reason, ...status() };
}

/**
 * Reopen the port this computer used last time. Called at startup, which
 * includes every restart after a crash — so a bridge that dies mid-session
 * comes back on the same port by itself, with nothing for the operator to do.
 */
async function restoreSaved() {
  if (!settings.port) return { restored: false, reason: 'nothing saved' };
  try {
    const SerialPort = loadSerialPort();
    const ports = await listPorts(SerialPort);
    const { port, reason } = config.findSaved(settings, ports);
    if (!port) { log('warn', `not reconnecting: ${reason}`); return { restored: false, reason }; }
    // force:true because the saved port may be a simulator or an RS232
    // adapter — the operator already made that decision once, and we are
    // restoring it, not making it again.
    await doConnect({ path: port.path, baud: settings.baud, force: true, remember: false });
    if (port.path !== settings.port) settings = config.save({ port: port.path });
    log('info', `reconnected: ${reason}`);
    return { restored: true, reason };
  } catch (e) {
    log('warn', `could not restore the saved port: ${e.message}`);
    return { restored: false, reason: e.message };
  }
}

const COMMANDS = {
  'list-ports':   () => doListPorts(),
  'auto-connect': () => doAutoConnect(),
  'connect':      msg => doConnect(msg),
  // Disconnect is deliberate, so forget the port too: otherwise the next
  // restart would silently reopen something the operator just closed.
  'disconnect':   async () => {
    await connection.close();
    connectedTo = null;
    reconnecting = null;
    settings = config.save({ port: null, serial_number: null });
    return status();
  },
  'status':       async () => status(),
  'configure':    async msg => {
    validator = createValidator({ ...(msg.validation ?? {}), mode: msg.mode ?? validator.mode });
    // Only `mode` is a property of this venue's hardware setup, so only that
    // is written to the machine-local file. The plausible run-time bounds
    // describe the COURSE and belong with the competition, in the database.
    if (msg.mode) settings = config.save({ mode: msg.mode });
    return status();
  },
  // Explicit shutdown, because Windows does not deliver SIGTERM: the signal
  // handlers below only ever run on Linux. Close the port first so the device
  // is released cleanly rather than when the process is torn down.
  'shutdown':     async () => {
    await connection.close();
    setTimeout(() => process.exit(0), 50).unref();
    return { stopping: true };
  },
};

process.on('message', async msg => {
  const handler = COMMANDS[msg?.cmd];
  if (!handler) { send({ id: msg?.id, ok: false, error: `Unknown command "${msg?.cmd}"` }); return; }
  try {
    send({ id: msg.id, ok: true, ...(await handler(msg)) });
  } catch (e) {
    send({ id: msg.id, ok: false, error: e.message, code: e.code ?? null, port: e.port ?? null });
  }
});

// A bridge that dies must not take the server with it, and must not die
// silently either — report, then let the parent restart us.
process.on('uncaughtException', err => {
  log('error', `bridge crashed: ${err.stack}`);
  process.exit(1);
});

const shutdown = () => connection.close().finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

emit('status', { ...status(), ready: true });

// Reopen last time's port before anything else. Deliberately not awaited: the
// bridge must report ready immediately so kx-server's routes work even while
// a missing device is being looked for.
restoreSaved().then(r => emit('status', { ...status(), restore: r }));

// ---------------------------------------------------------- standalone
if (standalone) {
  const args = process.argv.slice(2);
  const portArg = args[args.indexOf('--port') + 1];
  (async () => {
    if (args.includes('--list')) { send({ id: 'cli', ok: true, ...(await doListPorts()) }); return; }
    if (portArg && args.indexOf('--port') !== -1) {
      await doConnect({ path: portArg, force: args.includes('--force') });
      return;                                   // stay alive, print impulses
    }
    send({ id: 'cli', ok: true, ...(await doAutoConnect()) });
  })().catch(e => { send({ id: 'cli', ok: false, error: e.message, code: e.code ?? null }); });
}
