# Building the Windows installation package

Two artefacts come out of one command: an installer (`KX-Results-0.2.0-x64.exe`)
and a portable executable that runs from a folder or a USB stick without being
installed. Both are useful — a venue laptop you are not allowed to install
software on is a normal situation at a competition.

## What you need

- Windows 10 or 11, 64-bit
- Node.js 22.5 or newer, with npm — <https://nodejs.org>
- About 1 GB free for the Electron download and the build output

That is the whole list. No Visual Studio, no Python, no build tools. The one
native dependency, the serial binding, is an N-API addon and ships as a prebuilt
binary that works in Electron unchanged.

Build on Windows. Cross-building from Linux or macOS can be made to work, but
you cannot test the result, and an installer you have not run is not an
installer you can hand to a Chief of Scoring on competition morning.

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

## 2. Make the icons

electron-builder cannot read SVG, so `public/favicon.svg` has to be converted
once. Put the results in a `build/` folder at the project root:

```
build/icon.ico     Windows — multi-size, must include 256x256
build/icon.png     Linux — 512x512
build/icon.icns    macOS — only needed for a Mac build
```

The quickest route, which produces all three from the SVG:

```
npm exec -- electron-icon-builder --input=public/favicon.svg --output=build --flatten
```

Rename what it produces to the three names above. Any icon editor or an online
SVG-to-ICO converter does the same job; the only hard requirement is that the
`.ico` contains a 256×256 image, or Windows shows a blurry icon in the
Start menu.

If you would rather ship without custom icons for now, delete the three `icon`
lines from the `build` block in `package.json` and electron-builder will use the
default Electron icon.

## 3. Build

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
```

## 4. Test the installer on a clean machine

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

## Signing, if you want to lose the SmartScreen warning

Unsigned is perfectly usable — the operator clicks through one warning per
installation. Signing removes it, and needs a certificate you have to buy:

- **Azure Trusted Signing** — currently the cheapest route, ~$10/month, and
  gets SmartScreen reputation immediately.
- **OV code signing certificate** — a few hundred euro a year, and SmartScreen
  reputation builds up only after enough downloads.
- **EV code signing certificate** — the most expensive, immediate reputation,
  usually requires a hardware token.

With a `.pfx` file, electron-builder picks it up from the environment:

```
set CSC_LINK=C:\path\to\certificate.pfx
set CSC_KEY_PASSWORD=<password>
npm run dist:win
```

Do not put the certificate or its password in `package.json`.

## Version numbers

The installer filename and the version shown in the launcher both come from
`version` in `package.json`. Bump it before each release you hand out, or two
different builds will arrive at a competition with the same name.
