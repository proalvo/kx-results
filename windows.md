# How to make Microsoft Windows 10/11 executable

*kx-results* is electron based app, so it is possible to make it as native Windows application.

Two artefacts come out of one command: an installer (`KX-Results-0.2.0-x64.exe`)
and a portable executable that runs from a folder or a USB stick without being
installed. Both are useful — a venue laptop you are not allowed to install
software on is a normal situation at a competition.

## 1. Install the dependencies

From the project folder, in PowerShell or Command Prompt:

```
npm install
```

This fetches Electron and electron-builder, then installs the timing bridge's
serialport dependency.

Check that it works before packaging anything:

```
npm start
```

The launcher window should open. Press **Launch User Interface**, confirm the
browser opens `start.html`, then **Quit**.


## 2. Build

```
npm run dist:win
```

Roughly two minutes the first time. Output lands in `dist/`:

| File | What it is |
|---|---|
| `KX-Results-0.2.0-x64.exe` | the NSIS installer |
| `KX-Results-0.2.0-x64.exe` (in `dist/`, portable target) | the portable build |
| `win-unpacked/` | the raw application folder, for testing |

To build both 64-bit and ARM (Surface machines and similar):

```
npm exec -- electron-builder --win --x64 --arm64

## 3. Test the installer on a clean machine

Install it, then check the three things that only break on a real Windows box:

**Windows SmartScreen.** An unsigned installer shows "Windows protected your
PC". Choose **More info → Run anyway**. See below if you want that to stop.

**Windows Firewall.** The first time the server binds a network address,
Windows asks whether to allow it. Tick **Private networks** and allow. Refuse,
and the launcher will still say the server is running while every Gate Judge
phone times out — the confusing failure worth rehearsing before competition day.
This prompt does not appear if the operator only ever picks the localhost
address.

**The COM port.** Plug in the Timy3, open the Phase page and confirm the timing
panel appears. If the panel is missing, the serial binding did not load; the
competition can still be run with times typed in by hand.


## Where the installed application puts things

```
C:\Users\<name>\AppData\Local\Programs\KX-Results\    the program (read-only)
C:\Users\<name>\AppData\Roaming\KX-Results\           kx.db, launcher.json,
                                                      timy-config.json
```

The installer is per-user by default (`perMachine: false`), so it needs no
administrator rights — which matters on a borrowed or managed venue laptop.
Uninstalling leaves the `Roaming` folder alone, so competition databases survive
an upgrade. Tell the Chief of Scoring where `kx.db` lives; it is the file worth
backing up.


## Version numbers

The installer filename and the version shown in the launcher both come from
`version` in `package.json`. Bump it before each release you hand out, or two
different builds will arrive at a competition with the same name.
