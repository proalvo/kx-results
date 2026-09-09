# timy-bridge — ALGE Timy3 timing for KX-Results

Optional. Delete this folder and KX-Results works exactly as before, with Time
Trial times entered by hand.

## Install (only on the scoring PC that has the Timy3)

```
cd timy-bridge
npm install
```

That installs `serialport`, the only runtime dependency in the whole project.
kx-server itself stays dependency-free.

## How it starts

kx-server checks for `timy-bridge/index.js` at startup. If it is there, the
bridge is forked as a child process; if not, `GET /api/timy/status` answers
`{ available: false }` and the Phase page hides the timing panel. There is
nothing separate for the Chief of Scoring to launch, and a crash in the native
serial layer takes down the child only — the parent restarts it with backoff.

Wire it up in `server.js` next to the other attach calls:

```js
const { attachTimy } = require('./lib/timy-wire');
...
const timy = attachTimy(db, routes, notify);   // no-op when timy-bridge/ is absent
```

## Finding the Timy3

On connect the bridge lists every serial port and classifies it:

| Confidence | Meaning | Behaviour |
|---|---|---|
| `timy` | ALGE USB id `0c4a:0889/088a/088b`, or a manufacturer string containing ALGE | auto-connects, if exactly one is found |
| `possible` | generic USB-serial adapter (FTDI, Prolific, CP210x, CH340) — could be a Timy3 on an RS232 cable | offered, not auto-connected |
| `unknown` | anything else, including a simulator on a virtual port | offered, connect with `force: true` |

Two ALGE devices is an ambiguity, not a coin toss: the bridge connects to
neither and asks. Every port stays connectable — `POST /api/timy/connect` with
`{ "force": true }` opens an unrecognised port, which is how you drive the
whole chain from a simulator.

## Timy3 settings

* Baud 9600, 8 data bits, no parity, 1 stop bit (the bridge's default).
* Interface > RS-232 > handshake > `NO RTS-CTS`, or the device can go silent
  over USB.
* Channel blocking times (`DTS`/`DTF`) are the device's own defence against a
  paddle blade re-triggering the finish gate. Set them; `lib/validate.js`
  assumes you might not have.
* The Timy must send the **actual run time** (an RT/TT channel). If your
  program sends `c0`/`c1` times of day instead, switch the bridge with
  `POST /api/timy/configure { "mode": "time_of_day" }` and it pairs start to
  finish per bib itself.

## Where the port is remembered

`timy-bridge/timy-config.json`, written by the bridge itself:

```json
{ "port": "/dev/ttyUSB0", "serial_number": "ALGE1234", "baud": 9600, "mode": "run_time" }
```

Not in the database, and deliberately so. `kx.db` gets copied between
computers — including `server_setting`, which sits inside it — and a port
name is a fact about one machine, not about the competition. This folder is
already the machine boundary (`node_modules` here holds a platform-specific
binary and is never copied either), so the config belongs beside it. Both are
in `.gitignore`.

The bridge reads the file at startup and reopens the port on its own. That
covers the restart after a crash as well as the first launch of the morning,
so a mid-session bridge failure recovers with nothing for the operator to do.
If the saved path has moved — Windows renumbers COM ports when the device
goes into a different USB socket — the device is found again by serial number
and the file is updated. Pressing *Disconnect* clears the saved port, so a
deliberate disconnection is not undone by the next restart.

The plausible run-time bounds are NOT stored here: how fast and slow a run can
sensibly be describes the course, not the computer, so it should travel with
the competition in the database.

## Validation

`lib/validate.js` decides whether an impulse may be *offered* as a result —
never whether it is one. Rejected impulses are still forwarded and stored, so
the operator sees a flagged line rather than a silent gap.

| Reject code | Cause |
|---|---|
| `INFO_FLAG` | memory replay, deletion, disqualification or ID change — bookkeeping, not a result |
| `NO_BIB` | no start number on the Timy |
| `DUPLICATE` | second impulse on the same channel within 3 s — the paddle blade following the boat |
| `TOO_FAST` / `TOO_SLOW` | outside the plausible run window (20 s – 5 min by default) |
| `UNPAIRED_FINISH` | finish with no matching start (time-of-day mode) |
| `STALE_START` | start too old to belong to this finish |
| `CLOCK_BACKWARDS` | the Timy was re-synced mid-session |

Tune the thresholds per competition with `POST /api/timy/configure`:

```json
{ "validation": { "min_run_time_ms": 30000, "max_run_time_ms": 180000 } }
```

Nothing reaches the `result` table until `POST /api/timy/impulses/:id/confirm`.

## Testing without a Timy3

```
node --test                 # parser, discovery and validation, no hardware
node index.js --list        # what the port dropdown will show
node index.js --port COM7 --force   # drive it from a simulator
```

For an end-to-end rehearsal, make a virtual port pair (`socat -d -d
pty,raw,echo=0 pty,raw,echo=0` on Linux, com0com on Windows), connect the
bridge to one end with `--force`, and write sample lines to the other:

```
 0014 RT  00:00:44.2800 00
 0015 RT  00:00:47.9100 00
```

## Files

| File | Role |
|---|---|
| `index.js` | child process, IPC command handling |
| `lib/protocol.js` | ALGE ASCII line parser — pure, no I/O |
| `lib/discovery.js` | port listing and Timy3 recognition |
| `lib/serial.js` | serial connection, line framing, reconnect |
| `lib/validate.js` | false-trigger and plausibility filtering |
