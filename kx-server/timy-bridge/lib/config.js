// timy-bridge/lib/config.js — machine-local settings, stored as JSON.
//
// Which serial port the Timy3 is on is a fact about THIS COMPUTER, not about
// the competition. It must not travel when kx.db is copied to another laptop,
// so it deliberately does not live in the database — not even in
// server_setting, which sits inside kx.db and would be carried along with it.
//
// The file lives inside timy-bridge/ because that folder is already the
// machine boundary: node_modules there holds a platform-specific binary and
// is never copied between machines either. Add it to .gitignore.
//
// The BRIDGE owns this file, not kx-server. That is what makes recovery
// automatic: when the child process is restarted after a crash, it reads its
// own config and reopens the port without the parent having to remember
// anything or the operator having to touch the Setup page.
//
// What belongs here (properties of the venue and the hardware):
//   port, serial_number, baud, mode
// What does NOT belong here (properties of the competition, which SHOULD
// travel with the database): plausible run-time bounds — a course's fastest
// and slowest sensible run is the same wherever the results are opened.

'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'timy-config.json');

const EMPTY = { port: null, serial_number: null, baud: 9600, mode: 'run_time' };

/** Read the file. A missing or corrupt file is not an error — we start fresh. */
function load() {
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[timy] ignoring unreadable ${CONFIG_PATH}: ${e.message}`);
    }
    return { ...EMPTY };
  }
}

/**
 * Write via a temporary file and rename, so a power cut during a competition
 * cannot leave a half-written config that stops the bridge starting next time.
 */
function save(patch) {
  const next = { ...load(), ...patch, saved_at: new Date().toISOString() };
  const tmp = `${CONFIG_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    console.error(`[timy] could not save ${CONFIG_PATH}: ${e.message}`);
  }
  return next;
}

function clear() {
  try { fs.unlinkSync(CONFIG_PATH); } catch { /* already gone */ }
}

/**
 * Find the saved device among the ports currently present.
 *
 * Path first, then USB serial number — because Windows renumbers COM ports
 * when the Timy is plugged into a different socket, and Linux moves a device
 * between ttyUSB0 and ttyUSB1 depending on what else was connected at boot.
 * The serial number is the only stable identifier, so a remembered port that
 * has moved is still found.
 *
 * @returns {{port: object|null, reason: string}}
 */
function findSaved(cfg, ports) {
  if (!cfg.port) return { port: null, reason: 'no port saved on this computer' };

  const byPath = ports.find(p => p.path === cfg.port);
  if (byPath && (!cfg.serial_number || byPath.serial_number === cfg.serial_number)) {
    return { port: byPath, reason: `saved port ${cfg.port}` };
  }

  if (cfg.serial_number) {
    const moved = ports.find(p => p.serial_number === cfg.serial_number);
    if (moved) {
      return { port: moved, reason:
        `saved device found on ${moved.path} instead of ${cfg.port} — it was ` +
        'plugged into a different USB socket' };
    }
  }

  return { port: null, reason: `saved port ${cfg.port} is not present` };
}

module.exports = { load, save, clear, findSaved, findSavedPort: findSaved, CONFIG_PATH, EMPTY };
