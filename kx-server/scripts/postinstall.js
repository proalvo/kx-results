// scripts/postinstall.js — install the timing bridge's serial dependency.
//
// @serialport/bindings-cpp is an N-API addon (napi_versions: 8, built with
// `prebuildify --napi`). N-API is ABI-stable across Node versions AND across
// Electron, so the prebuilt binary npm downloads loads unchanged in both the
// desktop application and a plain `node server.js`. There is nothing to
// compile and no toolchain to install on any platform, and the same
// installation serves both ways of running the software.
//
// So this script does one thing: install timy-bridge's dependencies, and stay
// quiet about it. The rebuild escape hatch below exists only for the case
// where a prebuild is genuinely missing for the machine's platform (an unusual
// architecture, say), and it has to be asked for.
//
// Nothing here is allowed to fail the install. A missing serial binding means
// the Timy panel does not appear and Time Trial times are typed in by hand,
// which is a normal way to run a competition, not a broken installation.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'timy-bridge');
const note = msg => console.log(`[kx] ${msg}`);

if (process.env.KX_SKIP_TIMY_INSTALL === '1') {
  note('KX_SKIP_TIMY_INSTALL=1 — skipping the timing bridge entirely.');
  process.exit(0);
}

if (!fs.existsSync(path.join(BRIDGE, 'package.json'))) {
  note('no timy-bridge/ folder — nothing to install.');
  process.exit(0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args) =>
  spawnSync(npm, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });

const install = run(['install', '--prefix', 'timy-bridge', '--no-audit', '--no-fund']);
if (install.status !== 0) {
  note('serialport could not be installed. KX-Results will run without ALGE Timy');
  note('timing; Time Trial times are entered by hand.');
  process.exit(0);
}

// Opt-in only. Compiling from source needs a C++ toolchain and REPLACES a
// working prebuild, so it must never happen by accident.
if (process.env.KX_REBUILD_SERIALPORT === '1') {
  note('KX_REBUILD_SERIALPORT=1 — compiling serialport from source for Electron.');
  const rebuild = run(['exec', '--', '@electron/rebuild', '--module-dir', 'timy-bridge', '--force']);
  if (rebuild.status !== 0) {
    note('The rebuild failed. The prebuilt N-API binary is normally the right');
    note('one anyway; try starting the software before doing anything else.');
  }
}
process.exit(0);
