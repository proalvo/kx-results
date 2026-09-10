# KX-Results as a desktop application

The competition software is now started by double-clicking an icon instead of
by typing `node server.js` in a terminal, and the ALGE Timy3 bridge ships
inside it. Nothing about the results pages changed: they are the same HTML
pages served over HTTP, opened in the operator's own browser.

## What the launcher does

Starting KX-Results opens one small window, 400 × 500, containing the logo, the
title, an address dropdown, a port, a database, and two buttons.

**Launch User Interface** starts the results server with the settings shown and
opens `start.html` in the default browser. Pressing it again while the server is
already running just opens the browser again. Changing the address, port or
database and pressing it restarts the server, because those three things are
decided when the server starts.

**Quit** stops the timing bridge, closes the results server and ends the
application. Closing the window does the same: the pages open in the browser are
served by this application, so a launcher that quietly kept running would be a
results server nobody could see or stop.

### The address dropdown decides who can reach the competition

- `http://localhost` binds `127.0.0.1`. Only this computer can reach the
  results — useful on venue wifi you do not control.
- `http://<your address>` binds `0.0.0.0`. This is what the Gate Judge phones,
  the 24" leaderboard screen and the stream overlays need.

Every IPv4 address of the machine is listed, so a laptop on both ethernet and
wifi shows both and the operator picks the network the officials are on.

## Where files are written

Nothing is written next to the program, which is read-only once installed.
Everything goes to the per-user data folder (`app.getPath('userData')`):

| File | What it is |
|---|---|
| `kx.db` | the competition database — the default, changeable in the launcher |
| `launcher.json` | the last address, port and database used |
| `timy-config.json` | which serial port the Timy3 is on, on this machine |

A database name with no path (`kx.db`) means "in that folder". A name with a
path, or one chosen with **Browse…**, is used exactly as given, so a database on
a USB stick or a shared drive works.

## Running on Linux without Electron

Yes — this still works, and it needs no npm install at all:

```
node server.js kx.db 3000
```

`server.js` keeps its zero-dependency design (`node:http` + `node:sqlite`,
Node >= 22.5), argv still wins over the environment, and the
`timy-bridge/timy-config.json` fallback path is unchanged. The Electron files
are simply never loaded. Only two habits change on a terminal machine:

- `npm start` now launches the desktop window. Use `npm run start:server`, or
  just `node server.js`, for the plain server.
- `npm install` also installs the timing bridge's serial dependency. Use
  `npm install --omit=dev` to skip Electron itself, or `KX_SKIP_TIMY_INSTALL=1`
  to skip the bridge dependency too.

The serial binding is N-API, so the same prebuilt binary works under plain Node
and under Electron. One machine can be used both ways with one installation.

## Running from a checkout

```
npm install          # installs Electron, then timy-bridge, then rebuilds serialport
npm start            # the desktop launcher
npm run start:server # the plain terminal server, unchanged
npm test
```

`node server.js [dbfile] [port]` still works and still needs nothing installed.
The server has no runtime dependencies; Electron is a build-time dependency of
the desktop shell only.

## Building installers

```
npm run dist:win     # NSIS installer + portable .exe
npm run dist:mac     # dmg + zip
npm run dist:linux   # AppImage + deb
```

Build on the target platform, or the serial binding will be the wrong one.
Before the first build, put icons in `build/`: `icon.ico`, `icon.icns` and a
256×256 `icon.png`. `public/favicon.svg` is the source artwork, but
electron-builder cannot read SVG.

Add to `.gitignore`:

```
node_modules/
timy-bridge/node_modules/
timy-bridge/timy-config.json
dist/
*.db
```

## serialport needs no compiler

The results server runs inside the Electron binary with `ELECTRON_RUN_AS_NODE`,
so the app needs no separate Node installation. `@serialport/bindings-cpp` is an
N-API addon (`napi_versions: 8`, built with `prebuildify --napi`), and N-API is
ABI-stable across both Node versions and Electron — the prebuilt binary npm
downloads loads unchanged in either. No build tools, no `electron-rebuild`.
`KX_REBUILD_SERIALPORT=1` forces a source build for the rare platform with no
prebuild.

If the binding is missing anyway, **the application still starts and the
competition still runs.** The bridge reports `serialport_available: false`, the
Phase page does not offer the timing panel, and Time Trial times are typed in by
hand, exactly as on a laptop with no timing hardware. That was already the
designed behaviour for an absent bridge; bundling the bridge did not change it.

`timy-bridge/` is unpacked out of `app.asar` for this reason (`asarUnpack` in
`package.json`). If the bridge ever misbehaves in a packaged build, setting
`"asar": false` in the build config removes every archive-path subtlety at once,
at the cost of install size and nothing else.

## Changes to existing files

Only two, both backward-compatible:

**`server.js`** — reads `KX_DB_FILE`, `KX_PORT` and `KX_HOST` when no command
line arguments are given (argv still wins), and exports `start()` and `stop()`.
`start()` rejects with the listen error instead of printing it, which is what
lets the launcher say "Port 3000 is already in use" rather than dying silently.

**`timy-bridge/lib/config.js`** — honours `KX_TIMY_CONFIG` for the location of
`timy-config.json`. Run from a checkout, nothing sets that variable and the file
stays where it always was.

Everything else — `lib/`, `public/`, `rules/`, `schema.sql`, the tests — is
untouched.

## New files

```
electron/main.js          the desktop shell: window, server child, IPC
electron/preload.js       the five things the launcher page may do
electron/launcher.html    the 400x500 window
electron/server-child.js  requires server.js and calls start()
scripts/postinstall.js    installs the timing bridge's serial dependency
```

The server runs as a child process rather than inside the Electron main
process. A synchronous SQLite query cannot then freeze the launcher, and a crash
in the results server leaves a window that can still restart it.
