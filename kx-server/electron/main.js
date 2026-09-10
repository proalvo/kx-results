// electron/main.js — the desktop shell for KX-Results.
//
// What this process does, and deliberately does not do:
//
//   * It shows ONE window: the 400x500 launcher. Every page of the actual
//     application (Phase, Setup, Gate Judge, leaderboard, stream overlays)
//     stays an ordinary HTML page served over HTTP and opened in the
//     operator's own browser. That is not a shortcut — those pages are used on
//     other machines too: the Gate Judge opens gate-judge.html on a phone, the
//     leaderboard runs on a 24" screen driven by a second computer, and the
//     stream overlays are captured as browser sources. A page that only worked
//     inside an Electron window would be a page that stopped working at the
//     one moment it matters.
//
//   * It does NOT run the HTTP server itself. server.js is forked as a child
//     process, so a synchronous SQLite query cannot freeze the launcher, and a
//     crash in the results server leaves a window that can still restart it.
//
//   * It ships timy-bridge as part of the application. The bridge is still
//     started by the server (lib/timy-wire.js forks it when the folder is
//     present) — the difference here is only that the folder is always
//     present, so a Timy3 plugged into a packaged installation works with no
//     extra install step. If the serial binding cannot load, the bridge
//     reports serialport_available:false and Time Trial times are typed in by
//     hand, exactly as on a machine with no timing hardware.

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { fork } = require('node:child_process');

// In a packaged build __dirname is inside app.asar (read-only); in a checkout
// it is the repository. APP_ROOT is where server.js, public/ and timy-bridge/
// live either way.
const APP_ROOT = path.join(__dirname, '..');
const SERVER_CHILD = path.join(__dirname, 'server-child.js');

// Everything the application writes goes here: the competition database, the
// remembered launcher settings, and the timing bridge's machine-local config.
// Nothing is written next to the executable, which is read-only once installed.
//
// MSIX/AppX is the exception. There, %APPDATA% is virtualized into the package
// container and uninstalling the application deletes the container with it — a
// competition database under userData would disappear along with the app. Store
// builds therefore keep their data in Documents, which survives uninstall and
// is somewhere the Chief of Scoring can find, copy and back up.
// process.windowsStore is set by Electron only in a packaged Store build.
const DATA_DIR = process.windowsStore
  ? path.join(app.getPath('documents'), 'KX-Results')
  : app.getPath('userData');
const SETTINGS_FILE = path.join(DATA_DIR, 'launcher.json');
const TIMY_CONFIG = path.join(DATA_DIR, 'timy-config.json');

const DEFAULTS = { addressId: 'localhost', port: 3000, dbFile: 'kx.db' };

let win = null;
let child = null;                 // the running server, or null
let running = null;               // { url, port, dbPath, addressId } while up
let quitting = false;

// --------------------------------------------------------------- settings
function readSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };       // missing or corrupt: start from the defaults
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n');
  } catch (e) {
    console.error(`[kx] could not save launcher settings: ${e.message}`);
  }
  return next;
}

// -------------------------------------------------------------- addresses
// The dropdown offers localhost plus every real IPv4 address of this machine.
// Which one is chosen decides two things at once: the address the browser is
// sent to, and the address the server binds. Picking localhost means the
// competition is genuinely not reachable from the network — useful on venue
// wifi you do not control — and picking the LAN address is what the Gate Judge
// phones and the leaderboard screen need.
function listAddresses() {
  const out = [{
    id: 'localhost',
    label: 'http://localhost — this computer only',
    display: 'localhost',
    bindHost: '127.0.0.1',
  }];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      const family = a.family === 'IPv4' || a.family === 4;
      if (!family || a.internal) continue;
      out.push({
        id: a.address,
        label: `http://${a.address} — this network (${iface})`,
        display: a.address,
        bindHost: '0.0.0.0',
      });
    }
  }
  return out;
}

function resolveAddress(id) {
  const all = listAddresses();
  return all.find(a => a.id === id) ?? all[0];
}

// A bare name means "in the data folder"; a path the operator typed or picked
// is used as given, so a database on a USB stick or a shared drive works.
function resolveDb(dbFile) {
  const name = (dbFile ?? '').trim() || DEFAULTS.dbFile;
  return path.isAbsolute(name) || name.includes(path.sep) || name.includes('/')
    ? path.resolve(name)
    : path.join(DATA_DIR, name);
}

// ------------------------------------------------------------------- log
// A packaged application has nowhere to print to. When the server does not
// come up, this file is the only evidence of why, so it is written from the
// first line of the launch attempt rather than only when something fails.
const LOG_FILE = path.join(DATA_DIR, 'launcher.log');

function log(line) {
  const stamped = `${new Date().toISOString()}  ${line}\n`;
  process.stdout.write(`[kx] ${line}\n`);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, stamped);
  } catch { /* logging must never be the thing that breaks the app */ }
}

// ---------------------------------------------------------------- sqlite
// server.js opens the database with node:sqlite, which was flagged when it
// first shipped and unflagged later. Rather than probe for it — a synchronous
// spawn on the main thread freezes the window if it does not return — try the
// normal way first and retry once with the flag if the child says that is the
// problem. Current Electron bundles a Node where no flag is needed.
const SQLITE_RETRY = ['--experimental-sqlite'];
const looksLikeSqliteFlag = text =>
  /sqlite/i.test(text) && /(experimental|unknown|not defined|Cannot find module)/i.test(text);

// Pull the meaningful part out of a child's console output.
function excerpt(output) {
  const lines = (output ?? '').split('\n').map(l => l.trimEnd()).filter(Boolean);
  if (!lines.length) return '';
  const at = lines.findIndex(l => /(^|\s)(\w*Error|error:)/.test(l));
  return (at >= 0 ? lines.slice(at, at + 3) : lines.slice(0, 3)).join('\n');
}

// ------------------------------------------------------------- the server
function startServer({ addressId, port, dbFile }, execArgv = []) {
  return new Promise((resolve, reject) => {
    const address = resolveAddress(addressId);
    const dbPath = resolveDb(dbFile);

    try {
      // DATA_DIR holds the settings, the bridge config and the fork's cwd; the
      // database may sit elsewhere entirely if the operator chose a path.
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    } catch (e) {
      return reject(new Error(`Cannot use that database folder: ${e.message}`));
    }

    log(`starting: port=${port} host=${address.bindHost} db=${dbPath}`);
    log(`  execPath=${process.execPath}`);
    log(`  script=${SERVER_CHILD} exists=${fs.existsSync(SERVER_CHILD)}`);
    if (execArgv.length) log(`  execArgv=${execArgv.join(' ')}`);

    // cwd must be a real directory. In a packaged build APP_ROOT is
    // ...\resources\app.asar — a FILE — and Windows fails the spawn with
    // ENOENT, which is thrown synchronously out of fork() rather than arriving
    // as an 'error' event. Nothing the server does depends on cwd (public/,
    // schema.sql and timy-bridge/ are all resolved from __dirname, and the
    // database path is absolute), so point it at the data folder, which was
    // just created above and always exists.
    try {
      child = fork(SERVER_CHILD, [], {
        cwd: DATA_DIR,
        execArgv,
        // ELECTRON_RUN_AS_NODE makes this binary behave as plain Node, so the
        // server needs no separate Node installation. It is inherited by the
        // timing bridge that lib/timy-wire.js forks in turn.
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          KX_DB_FILE: dbPath,
          KX_PORT: String(port),
          KX_HOST: address.bindHost,
          KX_TIMY_CONFIG: TIMY_CONFIG,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (e) {
      return reject(new Error(`Could not start the results server: ${e.message}`));
    }

    let settled = false;

    // A spawn that fails after fork() returns arrives here rather than as an
    // exception. Without this listener it becomes an uncaught exception in the
    // main process, which Electron shows as a modal "A JavaScript error
    // occurred" dialog — a crash report where a status line would do.
    child.on('error', err => {
      if (settled) return;
      settled = true;
      reject(new Error(`Could not start the results server: ${err.message}`));
    });

    child.on('message', msg => {
      if (msg?.type === 'ready' && !settled) {
        settled = true;
        running = {
          url: `http://${address.display}:${msg.port}`,
          port: msg.port,
          dbPath,
          addressId: address.id,
        };
        sendStatus();
        resolve(running);
        return;
      }
      if (msg?.type === 'error' && !settled) {
        settled = true;
        // Carry the errno across: "EADDRINUSE" is what lets the launcher say
        // "choose a different port" instead of quoting a system message.
        reject(Object.assign(new Error(msg.message), { code: msg.code }));
      }
    });

    // Keep what the child said. If it dies, its last words are the only useful
    // thing to put in front of the operator, and they are gone otherwise.
    let output = '';
    const collect = d => {
      output = (output + d).slice(-4000);
      log(`  server: ${String(d).trimEnd()}`);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    // A child that neither reports ready nor exits would leave the launcher
    // saying "Starting the results server..." forever. Give it a bounded wait
    // and then say so, with whatever the child managed to print.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log('timed out waiting for the server to report ready');
      try { child?.kill(); } catch { /* already gone */ }
      reject(Object.assign(
        new Error('The results server did not start within 30 seconds.'),
        { output }));
    }, 30000);

    const finish = () => clearTimeout(timer);
    child.once('message', finish);

    const proc = child;
    child.on('exit', code => {
      finish();
      // Only the process that is still the current one may clear the state: a
      // late exit event from a replaced child must not blank out its successor.
      if (child === proc) { child = null; running = null; }
      if (!settled) {
        settled = true;
        log(`server exited before ready (code ${code})`);
        reject(Object.assign(
          new Error(`The results server stopped before it was ready (exit ${code}).`),
          { output }));
      }
      sendStatus();
    });
  });
}

// Ask before killing. The server has to close the serial port through the
// timing bridge and finish any write in progress; on Windows kill() is an
// unconditional terminate, so give it a moment first.
function stopServer() {
  return new Promise(resolve => {
    if (!child) { running = null; return resolve(); }
    const doomed = child;
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { if (!doomed.killed) doomed.kill(); resolve(); }, 4000);
    doomed.once('exit', done);
    try { doomed.send({ type: 'shutdown' }); } catch { doomed.kill(); }
  });
}

// ---------------------------------------------------------------- window
function sendStatus() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('kx:status', { running: running ? { ...running } : null });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 430,
    height: 600,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'KX-Results',
    backgroundColor: '#f4f8fb',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(APP_ROOT, 'public', 'favicon.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'launcher.html'));
  win.once('ready-to-show', () => win.show());

  // Nothing in the launcher should ever navigate; any link is a mistake or an
  // external address, and both belong in the operator's own browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

// ------------------------------------------------------------------- IPC
ipcMain.handle('kx:init', () => ({
  addresses: listAddresses(),
  settings: readSettings(),
  dataDir: DATA_DIR,
  version: app.getVersion(),
  running: running ? { ...running } : null,
}));

// Resolve a database name to a full path for the hint under the field, without
// creating anything. The renderer asks on every keystroke, so this stays a
// pure string operation.
ipcMain.handle('kx:resolve-db', (_e, dbFile) => resolveDb(dbFile));

ipcMain.handle('kx:browse-db', async (_e, dbFile) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Choose the competition database',
    defaultPath: resolveDb(dbFile),
    buttonLabel: 'Use this file',
    filters: [{ name: 'KX-Results database', extensions: ['db', 'sqlite'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  return canceled ? null : filePath;
});

// One button, one promise. If the server is already up on the same settings we
// only open the browser; if the settings changed we restart it, because the
// port and the database are decided when the server starts and there is no
// honest way to change them underneath a running competition.
ipcMain.handle('kx:launch', async (_e, form) => {
  const settings = writeSettings({
    addressId: form.addressId,
    port: Number(form.port) || DEFAULTS.port,
    dbFile: (form.dbFile ?? '').trim() || DEFAULTS.dbFile,
  });

  if (settings.port < 1 || settings.port > 65535) {
    throw new Error('Port must be a number between 1 and 65535.');
  }

  const wanted = {
    addressId: settings.addressId,
    port: settings.port,
    dbPath: resolveDb(settings.dbFile),
  };
  const same = running
    && running.addressId === wanted.addressId
    && running.port === wanted.port
    && running.dbPath === wanted.dbPath;

  if (!same) {
    await stopServer();
    try {
      try {
        await startServer(settings);
      } catch (first) {
        // One retry, only for the one failure a flag can fix.
        if (!looksLikeSqliteFlag(first.output ?? first.message ?? '')) throw first;
        log('retrying with --experimental-sqlite');
        await stopServer();
        await startServer(settings, SQLITE_RETRY);
      }
    } catch (e) {
      // The two failures an operator actually hits, said in terms of what to
      // do about them rather than in terms of errno.
      if (e.code === 'EADDRINUSE' || /EADDRINUSE/.test(e.message)) {
        throw new Error(`Port ${settings.port} is already in use. Choose a different port.`);
      }
      if (e.code === 'EACCES' || /EACCES/.test(e.message)) {
        throw new Error(`Port ${settings.port} is not available to this user. Try a port above 1024.`);
      }
      // Everything else: give the operator the child's own words and the path
      // to the log, which is the difference between a bug report that can be
      // acted on and "it does not work". Node prints the useful line near the
      // TOP of a crash dump and the version banner at the bottom, so pick the
      // first line that mentions an error rather than the last few lines.
      const tail = excerpt(e.output);
      throw new Error(`${e.message}${tail ? `\n\n${tail}` : ''}\n\nDetails: ${LOG_FILE}`);
    }
  }

  const url = `${running.url}/start.html`;
  log(`opening ${url}`);
  // openExternal resolving does not prove a browser appeared — a machine with
  // no default browser association fails here, and that is worth naming rather
  // than leaving the operator looking at a window that never came.
  try {
    await shell.openExternal(url);
  } catch (e) {
    log(`openExternal failed: ${e.message}`);
    throw new Error(`The server is running at ${running.url}, but the browser could not be opened `
                  + `(${e.message}). Type the address in manually.`);
  }
  return { ...running, opened: url };
});

ipcMain.handle('kx:quit', async () => {
  quitting = true;
  await stopServer();
  app.quit();
});

// ------------------------------------------------------------------- boot
// One instance only. Two launchers would fight over the same port and the same
// database file, and SQLite would be the one to complain about it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Closing the launcher closes the competition: the pages open in the browser
  // are served by this process's child, so leaving it running invisibly would
  // mean a results server nobody can see or stop.
  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', e => {
    if (!child || quitting) return;
    e.preventDefault();
    quitting = true;
    stopServer().then(() => app.quit());
  });
}
