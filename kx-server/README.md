# KX-Results — server skeleton (step 2 of stepwise development)

Result service for ICF Kayak Cross competitions. This skeleton contains the
**validated rules engine** (step 1: paper-competition simulation) wrapped in a
Node.js server with the **Phase page** for the Chief of Scoring.

Zero dependencies: requires only Node.js >= 22.5 (uses built-in `node:http`
and `node:sqlite`).

## Quick start

    node scripts/seed.js         # create kx.db with a demo competition
    node scripts/upload-rules.js # import the rest of the rule archive (rules/*.json)
    node server.js               # http://localhost:3000
    node --test                  # run the regression suite

On the Phase page: pick the demo event, click **Create Time Trial start
list**, enter times (m:ss.hh), **Auto-rank**, then **Apply progression** to
generate the quarter-finals. For heats: enter finish positions in the
*Finish* column, click gate cells to cycle penalties (— / FLT / RAL), set
DNS/DNF/DSQ in *Status*, then **Auto-rank**.

## Structure

    schema.sql            validated SQLite schema (UUID keys, audit trail)
    lib/db.js             database access (node:sqlite; better-sqlite3-compatible)
    lib/ranking.js        rankHeat / rankTimeTrial — confirmed ranking rules
    lib/progression.js    rule JSON import + applyProgression
    lib/api.js            JSON API routes
    server.js             http server, static files, SSE change stream
    public/index.html     Phase page (Chief of Scoring)
    scripts/seed.js       demo data
    scripts/upload-rules.js  import every rule in rules/ into a database
    test/engine.test.js   paper competition as automated regression tests
    rules/*.json          the progression rule archive (see "Progression
                           rules" below) — canonical files, used directly
                           by the test suite and seed scripts, not copies

## Confirmed rules encoded in lib/ranking.js

Heat ranking categories: clean finishers (finish order) → FLT → RAL (below
ALL FLT) → DNF → DNS → DSQ. FLT comparison: the athlete who progresses
furthest before their first fault ranks higher; equal prefixes → fewer
faults wins; identical fault lists → Time Trial time only. DNS/DSQ athletes
do **not** progress — their target slot is left empty for manual editing.

## Design principles

* **Progression proposes, the Chief disposes.** Every slot, rank, time,
  status and penalty is manually editable (national variants, exceptions).
  `applyProgression` refuses to overwrite an existing start list unless
  regeneration is explicitly confirmed.
* **Notify + fetch.** Mutations emit a lightweight change event on
  `GET /api/stream` (Server-Sent Events); clients re-fetch via the REST API.
  When `socket.io` is installed later, only the broadcast in `server.js`
  changes — every consumer (Phase page, Gate Judge, streaming, site sync)
  keeps fetching from the same API.
* **Audit trail.** Penalties are never deleted, only revoked
  (`revoked_at`/`revoked_by`) — protests can always be reconstructed.

- **`/stream-startlist.html`** and **`/stream-results.html`** — pure OBS
  Browser Source overlays, no selection UI, permanently fixed URLs (see
  "Streaming pages" below).
- **`/stream-startlist-control.html`** and **`/stream-results-control.html`**
  — the operator-facing remote controls for the two overlays above.

## Streaming pages

**Each overlay has exactly one URL, set into OBS once and never touched
again.** What it displays is controlled remotely from a separate control
page instead of being encoded in the URL — a big competition can have
dozens of heats over a day, and needing a different Browser Source URL for
each one isn't operable in practice. This is architecturally the same
"notify + fetch" pattern used everywhere else in the app, just applied one
level up: a small piece of server state (`stream_state` in schema.sql, one
row per stream) records what each overlay currently shows; the control
page writes to it (`PATCH /api/stream-state`), the overlay reads it and
refreshes live over SSE. Verified directly: the overlay's HTML is
byte-identical regardless of what query string it's loaded with, and every
change of what's on screen happens through a PATCH call, never a URL
change.

- **`stream-startlist.html`** (overlay) / **`stream-startlist-control.html`**
  (control): the control page picks a competition + event and clicks
  "Show this" — no phase/heat picker needed. Which of two things it shows
  is decided by `decideMode()` in the page (unit-tested):
  - **No active heat yet, and the event hasn't progressed past TT** → the
    TT start list (bib, name, club-or-country — see below),
    paginated/rotating if long. Prefers the real persisted TT order, falls
    back to the raw uploaded roster if the Chief hasn't clicked "Create
    Time Trial start list" yet. **Deliberately does not require Live
    Tracking to be on** — that toggle exists to control what Gate Judges
    see, and requiring it just to publish a start list made this overlay
    look permanently blank to a streaming operator working well before
    the Chief starts judging (a real bug, found and fixed: see "Known
    issues fixed").
  - **Active heat is TT itself** → same start list.
  - **Active heat is a later phase** → a lower-third bar with that heat's
    bib + name (never paginated — heats are small).
  - **No active heat, but the event has already progressed past TT** →
    nothing rendered, rather than reverting to a stale pre-competition
    start list once Live Tracking is toggled off mid-competition.
  - **No event selected on the control page, or zero athletes uploaded**
    → nothing rendered.

- **`stream-results.html`** (overlay) / **`stream-results-control.html`**
  (control): the control page picks a competition + event, then either
  "Official/Final Result" or "a specific heat's result" (with phase + heat
  dropdowns). Heat mode is deliberately independent of the Chief's
  active-heat pointer — the operator's selection stays on screen even
  after the Chief moves on to judging a different heat, live-updating if
  that heat's data is edited later (verified: corrected a rank in an
  already-displayed, already-passed heat and confirmed the overlay's data
  updates without the operator touching anything). Columns are rank, name,
  club-or-country — no bib, matching the spec's stated results table
  exactly (unlike the Start List's bib/name/club-or-country). Official
  mode shows nothing until the Chief has actually clicked "Compile
  Official Result" — an overlay shouldn't show a stale or empty "final
  result" before the event has actually finished. The Time Trial phase
  displays as "Time Trial" (not "TT"), and without a "— Heat N" suffix
  (unlike QF/SF/F, it's one continuous field, not multiple heats).

  **Heat Result mode** (not Official Result — see below) adds a fourth
  column: the athlete's time, *or* their fault/status instead of the time
  if they have one (`FLT @ G5`, `RAL @ G3`, `DNS`/`DNF`/`DSQ`) — a time is
  never shown next to an unseen fault, since rank already reflects the
  fault and the time didn't decide it. Priority is status > RAL > FLT >
  time, the same category order used to *rank* the row (`lib/ranking.js`),
  so the displayed reason always matches the reason for that rank.
  **Official Result mode does not get this column**: `compileOfficialResult`
  never carries `time_ms` or penalty data onto the compiled classification
  rows, so there's nothing to show there yet — extending this to Official
  Result would mean tracing each classified athlete back to whichever
  heat produced their result, which hasn't been built. Worth doing as a
  deliberate follow-up if wanted, not implied by this change.

**Pagination & rotation** (both pages, per the spec: *"Max 10 athletes per
table... table content changes after every 15 seconds"*): rows are split
into pages of 10 and cycled automatically. The rotation timer is
deliberately independent of the 8s data-refresh poll and SSE-triggered
refreshes — tested and confirmed this matters: during a busy event SSE
messages can fire more often than every 15 seconds, and if the rotation
timer were restarted on every data refresh (an easy mistake), rotation
would rarely get the chance to actually fire. The row *content* is
recomputed on every refresh; the countdown itself, and the current page
index, are untouched unless the underlying content genuinely changes
(tracked via a content key — switching TT↔lower-third, or between two
different heats, resets to page 1; an ordinary same-content refresh mid-
rotation does not). Verified directly: 25 rows → 3 pages of 10/10/5, a
5-row set never rotates, the timer is created exactly once no matter how
many times setup runs, and a tick both advances and wraps the page index
correctly.

**Club vs. country display** (`affiliation()`, duplicated identically in
both overlay pages per this project's self-contained-page convention,
unit-tested for all cases): `INTERNATIONAL` → always country; `DOMESTIC`
→ always club; `MIXED` → club if the athlete's country matches the
competition's own country, otherwise country.

## Editing

Competitions, events, and rules are all editable in place, not just
create-once:
- **Competitions** (Setup page): name, dates, location, country, and
  **type** (Domestic/International/Mixed — needed by the streaming
  graphics to decide what to display) are all inline-editable table cells.
- **Events** (Setup page): code, name, gate count, and progression rule
  (dropdown, can be cleared to "none") are inline-editable; the fit badge
  updates live against the current roster.
- **Rules** (Rules page): name and description are inline-editable.
  Steps and min/max athletes are deliberately NOT editable here — they
  define what the rule actually does and are tied to `checkRuleFits`
  results already shown elsewhere; re-upload a new rule for structural
  changes instead of silently changing one in place.

All three use the same PATCH pattern as the Phase page's inline edits
(`PATCH /api/competitions`, `/api/events`, `/api/rules` — whitelisted
fields only), with friendly messages for constraint violations (e.g.
duplicate rule name) instead of a raw database error.

## PDF printing

Start lists and results print from **any phase of the competition** —
the Phase page's "Print / PDF" button always opens `print.html` for
whatever phase/heat is currently selected, uniformly (TT, Q, RQ, QF, SF,
F, or the compiled RESULT). No per-phase special-casing.

**Implementation choice, and why:** rather than adding a PDF-generation
library, `print.html` is a clean, print-optimized HTML page
(`@media print` CSS, A4 portrait, table headers repeat on every printed
page) that uses the browser's own **Print → Save as PDF**. This needed no
new dependency and works completely offline, consistent with this
project's zero-dependency approach (`node:http` + `node:sqlite`, nothing
else) — and this sandbox has no network access to `npm install` a PDF
library even if one were wanted. If a deployment specifically wants
server-generated PDF files (e.g. for unattended/scripted printing) rather
than a human clicking Print, swapping in `pdfkit` or a headless-browser
approach (`puppeteer`) later is a contained change — `print.html`'s
rendering logic (columns, formatting, header/footer layout) would carry
over directly; only how the final bytes get produced would change.

**What it shows**, auto-detected from the data — no separate "print start
list" vs. "print results" button:
- **No ranks yet** → Start List (Slot, Bib, Name, Club/Country). For TT
  specifically, falls back to the raw uploaded roster if "Create Time
  Trial start list" hasn't been clicked yet, same as the streaming
  overlay.
- **Ranked** → Results (Rank, Bib, Name, Club/Country, Time-or-fault) —
  reuses the exact same `timeOrFault()` priority logic as
  `stream-results.html` (status > RAL > FLT > time; a time is never shown
  next to an unseen fault), verified to match it in the test suite.
- **Official Result** (`phase=RESULT`) → same table, no Time column —
  `compileOfficialResult` doesn't carry `time_ms` or penalty data onto
  the compiled classification rows, so (as with the streaming page) there
  is nothing there to show yet.

**Two things built for explicitly, per the brief, so they're not a
redesign later:**
- **Print date/time**: included now (`Printed <date> <time>` in the
  footer), not deferred — trivial to do immediately, no reason to wait.
- **Header/footer sponsor logo**: `#headerLogo` and `#footerLogo` are
  designated, correctly-sized, currently-empty extension points in the
  layout (`max-height` set, `object-fit: contain` ready for an `<img>`).
  Deliberately not built further than that in this first version — doing
  so needs a real design decision (per-competition logo? per-event?
  upload mechanism? one logo or a sponsor row?) that wasn't specified,
  and guessing at a data model for image storage isn't worth doing until
  that's answered. Once decided, wiring an `<img>` into either div is a
  small, contained change; nothing about today's layout would need to move.

## Active competition (session-wide)

One server instance is run by one Chief of Scoring / one organization at a
time (results get pushed to a separate central public website — not yet
built — which is where any cross-organization aggregation happens, not
here). So rather than picking a competition separately on the Phase page,
Setup's Events section, and Setup's Split-timing section (three redundant
pickers that could silently disagree), there is now exactly **one**
active-competition pointer (`app_state`, a singleton table — same pattern
as `stream_state`), shown and switchable from every admin page's nav bar,
and read by the Phase and Setup pages instead of each having their own
selector.

- **`start.html`** — the actual entry point: select an existing
  competition to make it active, or create a new one (which becomes
  active automatically). Every admin page redirects here on load if
  nothing is active yet, so a fresh server naturally lands here without
  anyone needing to know the URL.
- Switching is **global**, not per-browser: an SSE `app-state` message
  reloads any open Phase/Setup page immediately, on any tab, anywhere —
  matching how the active-heat pointer already behaves, and appropriate
  since one Chief of Scoring runs the show at a time.
- **Gate Judge and the streaming control pages deliberately do NOT
  follow this** — a judge's phone or a streaming PC may reasonably need
  to point at a different competition than whatever the Chief currently
  has open on their laptop (verified: logged a Gate Judge into a
  competition while a *different* one was active, and it worked
  correctly, independent of the admin session's selection).
- Setup's "1. Competitions" table still lists and edits *every*
  competition on the server (a Chief may be managing several across a
  season) — it's specifically the Events and Split-timing sections that
  scope to "whichever one is currently active."

## Pages

- **`/start.html` — Start Here**, the entry point: select or create the
  active competition (see "Active competition" above).
- **`/` (index.html) — Phase page**, for the Chief of Scoring during a
  competition: enter results, apply progression, edit anything manually.
  Has a "Print / PDF" button (see "PDF printing" below).
- **`/setup.html` — Setup page**, for preparing a competition beforehand:
  create competitions, create events and assign a progression rule (with a
  live "fits/doesn't fit" badge against the current roster), and upload
  athletes per the spec's CSV format.
- **`/rules.html` — Rules page**, separated out from Setup since
  progression rules are generic and reused across many competitions rather
  than created per-event: list existing rules (name, athlete range, step
  count) and upload new ones. Setup's "Add event" form still reads from
  the same rule list to populate its dropdown.

All three pages share the same live-update stream (`GET /api/stream`), so
e.g. uploading a rule on the Rules page makes it available immediately in
Setup's event-creation dropdown without a refresh.

- **`/gate-judge.html` — Gate Judge page**, mobile-first: PIN login (checked
  server-side only — the PIN is never sent to or compared in client-side
  JS), then pick an event and a gate number, then a live card per athlete
  in the *active heat* with FLT/RAL buttons (tap again to revoke). See
  "Active heat" below for how it knows what to show.

## Active heat

`event.current_phase` / `event.current_group` is the pointer Gate Judge
pages read to know what to display without any manual navigation on the
judge's phone. As of this update it's driven by a **Live tracking
toggle** on the Phase page rather than a one-off "set active" click: when
ON, whatever phase/heat is currently open on screen automatically becomes
the active heat (`event.live_tracking = 1`, kept reconciled on every
phase/heat change and on page reload); when OFF, the pointer is cleared
and Gate Judge phones show "waiting for the Chief." Gate Judge pages poll
every 8s as a fallback and also refresh immediately on `events`/`results`
SSE messages.

**Known simplification (flagged, not fixed yet):** there's no offline
queueing — a Gate Judge page that loses connectivity mid-heat will fail
silently on the next tap rather than queuing the penalty for later. The
original roadmap called for this; it's deferred pending real-world testing
of how much venue Wi-Fi actually drops in practice, since queuing safely
(dedup, ordering, conflict with a Chief's manual edit) is real design work
its own right. The PIN gate is also a shared-secret convenience, not a
full account/session system — anyone with the PIN can act as any judge.

## Finish position: persisted, and Finish Line judging

`result.finish_pos` (crossing-the-line order, e.g. 1st/2nd/3rd/4th) is now
a real, persisted column — previously it was a UI-only field on the Phase
page that got silently wiped whenever the table reloaded (which happens on
every Gate Judge penalty, since both use the same live-update channel).
That was a real bug: a Gate Judge adding a penalty could erase the Chief's
in-progress finish-order entry. Fixed by persisting it like every other
editable field (`PATCH /api/result`, included in `GET /api/phase`).

The Gate Judge page's gate grid now includes a **Finish Line** tile
alongside the numbered gates. Selecting it switches the athlete cards from
FLT/RAL buttons to: a **Time** field (m:ss.hh, same format/parsing as the
Phase page — used mainly for Time Trial), a **Finish position** field (used
in elimination heats where crossing order + penalties determine rank, not
raw time), and a **DNF** toggle button. All three write to the same
`result` row a Chief could edit manually on the Phase page — there's one
source of truth, just two ways to reach it.

## Split-time Time Trial timing

For competitions timed with stopwatches on one shared running clock
(no per-athlete chronometer): athletes start at a fixed interval,
offset by a constant so athlete 1 doesn't start at 0:00. At the finish
line the raw shared-stopwatch reading (the "split") is entered instead of
a direct time, and the actual result time is calculated automatically.

Configured per competition (Setup page, section "1a"): `tt_start_interval_ms`
and `tt_time_shift_ms` on `competition`, both nullable — leaving either
blank disables the feature entirely, which is the default for every
competition and behaves exactly as before (Time entered directly). The
athlete at TT slot **N** starts when the shared clock reads:

```
start_offset(N) = time_shift + (N - 1) * start_interval
```

and their actual result time is `split_time - start_offset(N)` (see
`lib/tt-timing.js`, unit-tested against the worked example above and for
the negative-result guard below).

**Where it's entered:** a new `split_time_ms` column on `result` holds the
raw reading; `time_ms` becomes the *computed* value, recalculated
automatically by `PATCH /api/result` whenever `split_time_ms` or `slot_no`
changes (so reordering the TT start list keeps times correct). Both the
Phase page (a "Split" column appears next to a now-read-only "Time"
column, TT phase only, only when the competition has this configured) and
the Gate Judge Finish Line screen (the "Time" field becomes "Split", with
the computed "Time (calc.)" shown alongside) feed the same
`split_time_ms` field — one calculation, reachable from either UI, so
nothing has to be duplicated or kept in sync by hand.

**Data-entry safety:** a split time earlier than the athlete's own
calculated start is rejected outright (this is always a mistake — wrong
slot, misread stopwatch, or entered before the athlete actually started)
rather than silently producing a negative or nonsensical time. The
rejection is atomic — wrapped in the same transaction as the initial
write, so a bad split never gets half-saved with a stale computed time.
Verified directly against the live server: the worked example from the
spec (60s interval, 5min shift → athlete 1 starts at 5:00, athlete 2 at
6:00, a split of 8:30 nets a 3:30 run), the negative-result rejection and
its atomic rollback, and that reordering `slot_no` recomputes `time_ms`
correctly.

**Worth confirming:** the numeric example used to describe this feature
("first athlete starts when the time in start line is 0:05.00, second
0:06.00") doesn't quite match the stated 60-second interval — a 60s gap
implies 5:00 → 6:00 (a full minute apart), not 0:05 → 0:06 (one second
apart). The implementation assumes 5:00/6:00, which is internally
consistent with "60 second interval, 5 minute shift" — please confirm
that's the intended reading before relying on this in a real competition.

## Athlete list order vs bib

`event_athlete.list_order` is a new explicit column recording each
athlete's position in the uploaded/entered list for that event — assigned
sequentially as athletes are added, independent of `bib`. The Time Trial
start list (`POST /api/phase/start-tt`) and the roster display
(`GET /api/athletes`, shown on the Setup page) both order by this instead
of by bib value. This means bib is now purely an identifier — the same bib
can be reused across different events (e.g. an athlete keeping the same
bib number in both Kayak Cross Men and a mixed relay), which previously
worked at the schema level (`UNIQUE (event_id, bib)` was always scoped per
event) but felt coupled to ordering since the TT start list derived its
order from casting bib to an integer. Verified live: uploading athletes
with descending bibs (50, 12, 3) produces a TT start list in that same
50-12-3 order, and the same bib now attaches cleanly to different athletes
in different events.

## Progression rules

Rules are JSON, uploaded on the Rules page or imported in bulk from the
`rules/` archive (`node scripts/upload-rules.js [dbfile]`, safe to re-run —
already-imported rules are skipped, not treated as errors). **CSV is not
supported** — the rule *file* carries its own name, description, and
athlete range, so there's nothing left to type into separate form fields
and nothing that can drift out of sync between a file and its metadata.

```json
{
  "rule_name": "ICF_2026_19-20-athletes",
  "description": "TT -> Q -> RQ -> QF -> SF -> Final (19-20 athletes)",
  "min_athletes": 19,
  "max_athletes": 20,
  "progression": [
    { "from": {"phase":"TT","group":0,"rank":1}, "to": {"phase":"QF","group":1,"slot":1} }
  ],
  "final_result": [
    { "base_rank": 1, "from": [ {"phase":"F","group":1,"rank":1} ] },
    { "base_rank": 17, "order_by": "tt_time",
      "from": [ {"phase":"Q","group":1,"rank":3}, {"phase":"Q","group":2,"rank":3} ] }
  ]
}
```

`progression` entries are heat-to-heat advancements (`group: 0` means
"whole-phase rank," used for TT). `final_result` entries are pools that
resolve directly to a final classification rank starting at `base_rank`;
a pool naming more than one source **must** declare `order_by` (only
`"tt_time"` is implemented) — this is deliberately a hard validation
error, not a silent default, since an unresolved tie-break was exactly
the kind of ambiguity that caused real bugs in earlier CSV-format rule
files (duplicate targets, orphaned slots — see git history / prior
conversation). `lib/progression.js`'s `importRuleJson()` validates every
field with a specific, actionable error message (bad phase name, missing
`order_by`, `min_athletes > max_athletes`, etc.) rather than failing
generically.

Internally this still becomes the same flat `progression_rule_step` rows
as before (`final_result` members become `to_phase='RESULT'`,
`to_group=0`, `to_slot=base_rank`) — `applyProgression` and
`compileOfficialResult` are unchanged.

`rules/` holds seven real, validated rules (12–16, 17–18, 19–20-with-RQ,
28-exact, and 4-, 6-, and 8-athlete no-B-final rules) — these are the actual files
used by the test suite and seed scripts, not copies kept in sync by hand.

## Rule metadata: min_athletes / max_athletes

`progression_rule` records the athlete-count range each rule is valid for
(`min_athletes`/`max_athletes` in the JSON, `checkRuleFits(rule,
athleteCount)` in code). `min === max` means exact-count-only (e.g.
`rules/rule_28_athletes_exact.json` requires precisely 28 — one fewer
produces gaps in the final classification, confirmed against the real
rulebook). `POST /api/phase/start-tt` checks the event's rule against its
actual entry count and rejects a mismatch by default; pass `force: true` to
override. Rules without a declared range always pass the check — the
guard never retroactively blocks existing data.

## Usability: fast entry, event/athlete deletion, favicon

- **Enter-to-advance** (Phase page): pressing Enter in a Time, Split, or
  Finish cell saves it (via the blur this triggers) and moves focus to the
  same field one row down, so the Chief can key through a whole heat
  without touching the mouse. Verified with a table-structure mock: correct
  row-to-row and column-isolated navigation, safe no-op on the last row and
  on non-Enter keys.
- **Fixed a real pre-existing bug this exposed**: every result edit
  broadcasts an SSE `results` message, which this same browser was also
  receiving and using to fully reload the table — silently destroying
  focus after *every* single edit, which would have made Enter-to-advance
  useless. Fixed with the same guard already proven on the Gate Judge
  Finish Line: skip the reload while a table input has focus.
- **Delete an event** (Setup page): allowed only while it has zero
  athletes uploaded — the Delete button is disabled with a tooltip
  otherwise, and the server enforces the same rule regardless of the
  button state.
- **Remove an athlete from an event** (Setup page): deletes the
  `event_athlete` link only — the athlete's master record is untouched
  (verified directly against the database) so they can still belong to
  other events/competitions. Blocked for the *whole* event, not just the
  one athlete, once any Time Trial time has been recorded (removing
  someone mid-competition would misalign bibs/slots for everyone else).
- **Favicon** on all nine pages (`public/favicon.svg`).

- **Other pages slow to load while a streaming overlay tab is open**:
  `stream-startlist.html`/`stream-results.html` only know an `event_id`
  (from `stream_state`), and were finding its competition by fetching
  *every* competition, then *every* event in each, until a match turned
  up — 1+N requests, refired on every 8s poll **and** every global
  `results`/`events`/`athletes` SSE message (not scoped to the streamed
  event), so rapid data entry elsewhere could trigger this scan
  continuously. Browsers cap concurrent connections per origin at ~6;
  each open streaming tab already holds one permanently for its SSE
  connection, so this scan could saturate the rest of the pool and starve
  other tabs' ordinary requests for a long time. Fixed by using
  `GET /api/stream-info?event_id=` (already existed, just wasn't wired up)
  — one request instead of 1+N. Verified with 8 competitions: 9 requests
  down to 1.

- **`rankTimeTrial` ignored FLT/RAL faults entirely**: it sorted purely by
  `time_ms`, so a faulted athlete's computed time could still outrank a
  clean athlete's slower one — the split-time feature made this concrete
  (a specific computed finish time sitting right next to an FLT badge)
  but the gap existed before that too, since TT ranking was never wired
  to the same category system (clean < FLT < RAL < DNF < DNS < DSQ)
  `rankHeat` already used for every other phase. Fixed by reusing that
  exact system for TT: for the clean category `time_ms` is still the
  primary sort key (there's no separate "finish order" in a Time Trial —
  the clock *is* the finish order), but a fault now overrides it, just
  like in a heat. `time_ms` itself is never cleared or altered — it stays
  in the database for a potential protest regardless of penalty status;
  it's only de-prioritized as a *sort key*. Separately confirmed (and
  pinned with a regression test) that public results — the streaming
  pages — never display a raw time at all, faulted or not, only rank and
  name/club-country; a faulted athlete's specific time is protest-only,
  not public.

## Known issues fixed

- **Bib uniqueness**: `UNIQUE (event_id, bib)` was already scoped per
  event, not global — the same bib has always been reusable across
  different events (e.g. an athlete entered in both Kayak Cross Men and a
  relay). Verified live against the running server to confirm this hadn't
  regressed. What genuinely needed fixing while checking: a duplicate bib
  *within* the same event aborted the entire upload batch with a raw
  `UNIQUE constraint failed: event_athlete.event_id, event_athlete.bib`
  error, discarding every other athlete on unrelated lines. Fixed to match
  the existing "unknown event" handling: a clean per-line error
  (`Line 3: bib "7" is already used in event "KXM"`), the rest of the
  batch still commits, and `list_order` stays contiguous (a rejected line
  doesn't burn a sequence number and leave a gap in the start order).

- **"TT" reference column going stale on direct Time entry (split timing
  off)**: this column (an athlete's Time Trial time, shown on every phase
  for context/tie-break reference — self-referential when viewing TT
  itself) was plain static text, never bound to updates; it only ever
  refreshed via a full `loadTable()` reload. The focus-preserving SSE
  guard added earlier (to protect Enter-to-advance) suppresses exactly
  that reload while a cell has focus — so entering a Time and continuing
  to type left the column looking stuck until navigating away and back.
  The split-timing case was already fine, since its computed-Time cell
  had its own in-place update; direct entry had no equivalent. Fixed by
  tagging the cell and updating it in place for both paths, using the
  `time_ms` `PATCH /api/result` already returns.

- **Start List overlay always blank**: it required `event.current_phase`
  to be set, which only happens once the Chief turns Live Tracking on — a
  streaming operator could correctly select an event on the control page
  and still see nothing, because that toggle exists to control Gate
  Judges, not to publish a start list, and a Chief setting up before a
  competition wouldn't have touched it yet. Fixed by decoupling the two:
  the TT list now shows whenever the event hasn't progressed past TT,
  independent of Live Tracking; the tracking pointer only matters once a
  later heat is genuinely active. The one thing preserved from the old
  behavior: once the event *has* progressed past TT, toggling tracking
  off correctly goes blank rather than reverting to a stale
  pre-competition list. See `decideMode()` in `stream-startlist.html`,
  unit-tested for all four states.

- **Progression guard**: applying progression from a phase whose heats
  exist but haven't been ranked yet now fails with a clear message instead
  of silently creating nothing (this was the cause of "RQ never appears").
- **Phase dropdown reset**: clicking "Apply progression" used to always
  reset the Phase selector back to TT (a `<select>` quirk: rebuilding
  `innerHTML` resets `selectedIndex`). It now selects the next phase in
  canonical order that has data, so the natural next click just continues
  the workflow.
- **Heat dropdown reset while Live tracking is ON**: the Heat/group
  `<select>` had the identical rebuild-resets-selection bug, missed when
  the phase one was fixed. Combined with Live tracking's auto-sync, this
  caused a real bug: selecting a new heat would visibly "snap back" to
  heat 1, because the server's own broadcast of the heat change reached
  the same browser, silently reset the dropdown, and the reconciliation
  logic then "corrected" the server back to the (wrongly reset) heat 1.
  Fixed the same way as the phase dropdown; verified by running the actual
  page script against a fake DOM and the real server, confirming the bug
  reproduces on the old code and is gone on the fix.
- **Gate Judge Finish Line requiring fast, perfectly-formatted input**:
  `refreshHeat()` ran unconditionally on an 8s poll and on every `results`
  SSE message (fired by any gate's activity, not just this one),
  regenerating all athlete cards and wiping in-progress typing. A bad time
  format also triggered `alert()` + a forced reload instead of leaving the
  value editable. Fixed to match the Phase page: skip the refresh while a
  text input has focus, and show a non-blocking inline error instead of
  alerting and reloading.

## Roadmap (each step validated before the next)

1. ~~Rules engine simulation~~ ✔
2. ~~Server skeleton + Phase page~~ ✔
3. ~~Setup page: competitions, events, rules, athlete upload~~ ✔
4. ~~Gate Judge mobile page skeleton~~ ✔ (this — PIN login, gate/heat
   selection, penalty entry against the real active-heat data; offline
   queueing and Socket.io still to come, see "Active heat" above)
5. Live streaming pages: ~~Start List~~ ✔, ~~Results~~ ✔ (this — official
   result and operator-selected heat result, both paginated/rotating)
6. ~~PDF printing of start lists and results~~ ✔ (this — browser
   print-to-PDF, available uniformly in every phase; see "PDF printing")
7. Public website sync (single idempotent POST /api/sync, API-key auth,
   incremental by updated_at) — MariaDB schema already drafted
