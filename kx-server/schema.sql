-- ============================================================================
-- KX-Results — Corrected database schema (SQLite)
-- ============================================================================
-- Conventions:
--   * All primary keys are UUIDs stored as TEXT (per spec: no auto-increment).
--   * Timestamps are ISO-8601 UTC strings (TEXT), e.g. '2026-07-09T12:34:56Z'.
--     Competition-local display time is derived via competition.time_zone.
--   * Times of runs are stored as INTEGER milliseconds (time_ms) to avoid
--     floating point issues; format as mm:ss.hh in the UI.
--   * "group" is a reserved word in SQL -> renamed to group_no everywhere.
--   * Every synchronisable table has created_at / updated_at so the public
--     website (MariaDB) can be updated incrementally ("give me everything
--     changed since X"). UUID keys make upserts on the website side trivial.
--   * Schema is written to be portable to MariaDB with minimal changes
--     (TEXT -> VARCHAR, CHECK constraints kept).
--
-- Enable FK enforcement in SQLite (must be set per connection):
PRAGMA foreign_keys = ON;

-- ============================================================================
-- 1. Competition
-- ============================================================================
CREATE TABLE competition (
    competition_id   TEXT PRIMARY KEY,                 -- uuid
    competition_name TEXT NOT NULL,                    -- e.g. 'Finnish Championships 2026'
    start_date       TEXT NOT NULL,                    -- ISO date 'YYYY-MM-DD'
    end_date         TEXT NOT NULL,
    country          TEXT NOT NULL CHECK (length(country) = 3),  -- IOC/ICF 3-letter code
    location         TEXT,                             -- e.g. city / venue
    time_zone        TEXT NOT NULL DEFAULT 'Europe/Helsinki',    -- IANA tz name
    type             TEXT NOT NULL DEFAULT 'DOMESTIC'
                     CHECK (type IN ('DOMESTIC','INTERNATIONAL','MIXED')),
    gate_judge_pin   TEXT NOT NULL,                    -- PIN for Gate Judge UI login
    api_key          TEXT,                             -- key used to push results to public website
    tt_start_interval_ms INTEGER CHECK (tt_start_interval_ms IS NULL OR tt_start_interval_ms >= 0),
                                                       -- Split-time TT timing (stopwatches with a
                                                       -- shared running clock, no per-athlete
                                                       -- chronometer): gap between consecutive
                                                       -- athletes' starts, e.g. 60000 (60s). NULL
                                                       -- (the default) disables the feature entirely
                                                       -- — Time is then entered directly as the
                                                       -- athlete's actual run time, unchanged from
                                                       -- how every other phase already works.
    tt_time_shift_ms     INTEGER CHECK (tt_time_shift_ms IS NULL OR tt_time_shift_ms >= 0),
                                                       -- Split-time TT timing: constant added before
                                                       -- the first athlete's start, e.g. 300000 (5
                                                       -- min) so athlete 1 starts at 5:00 on the
                                                       -- shared clock rather than at 0:00. Athlete at
                                                       -- TT slot N starts at
                                                       -- tt_time_shift_ms + (N-1) * tt_start_interval_ms
                                                       -- on that shared clock (see lib/tt-timing.js).
                                                       -- Must be set together with the interval
                                                       -- above for the feature to activate.
    active_event_id  TEXT,                             -- which event is currently "live"
                                                       -- (drives Gate Judge + streaming pages);
                                                       -- FK added via trigger-free soft reference
                                                       -- to avoid circular FK with event table
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Administrators of a competition (one row per admin email).
CREATE TABLE competition_admin (
    competition_id TEXT NOT NULL REFERENCES competition(competition_id) ON DELETE CASCADE,
    email          TEXT NOT NULL,
    password_hash  TEXT,                               -- nullable until auth flow is decided;
                                                       -- placeholder so accounts are possible later
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (competition_id, email)
);

-- Per-competition settings (e.g. streaming table rotation interval).
CREATE TABLE competition_setting (
    competition_id TEXT NOT NULL REFERENCES competition(competition_id) ON DELETE CASCADE,
    key            TEXT NOT NULL,                      -- e.g. 'streaming_rotate_seconds'
    value          TEXT NOT NULL,                      -- e.g. '15'
    PRIMARY KEY (competition_id, key)
);

-- ============================================================================
-- 2. Athlete master data
-- ============================================================================
-- One row per person, shared across competitions/events. Name/club/country
-- here are the *current* values; per-event snapshots live in event_athlete.
CREATE TABLE athlete (
    athlete_id TEXT PRIMARY KEY,                       -- uuid
    first_name TEXT NOT NULL,
    last_name  TEXT NOT NULL,
    club       TEXT,
    country    TEXT CHECK (country IS NULL OR length(country) = 3),
    icf_id     TEXT UNIQUE,                            -- ICF ID, optional
    nf_id      TEXT,                                   -- national federation ID, optional
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_athlete_nf_id ON athlete(nf_id);
CREATE INDEX idx_athlete_name  ON athlete(last_name, first_name);

-- ============================================================================
-- 3. Progression rules ("rules" in the UI)
-- ============================================================================
-- A named, reusable progression system, e.g. 'ICF_2026_12-18-athletes'.
CREATE TABLE progression_rule (
    rule_id     TEXT PRIMARY KEY,                      -- uuid
    rule_name   TEXT NOT NULL UNIQUE,
    description TEXT,
    min_athletes INTEGER,                               -- inclusive; NULL = unspecified
    max_athletes INTEGER,                               -- inclusive; NULL = unspecified
                                                        -- min_athletes = max_athletes means
                                                        -- the rule is exact-count-only (e.g.
                                                        -- a bracket sized for precisely 28
                                                        -- entrants; using it with fewer creates
                                                        -- gaps in the final classification).
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (min_athletes IS NULL OR max_athletes IS NULL OR min_athletes <= max_athletes)
);

-- One row per line of the uploaded rules CSV:
-- from_phase;from_group;from_rank;to_phase;to_group;to_slot
CREATE TABLE progression_rule_step (
    rule_id    TEXT NOT NULL REFERENCES progression_rule(rule_id) ON DELETE CASCADE,
    from_phase TEXT NOT NULL CHECK (from_phase IN ('TT','Q','RQ','QF','SF','F')),
    from_group INTEGER NOT NULL,                       -- 0 = whole-phase ranking (e.g. Time Trial)
    from_rank  INTEGER NOT NULL,
    to_phase   TEXT NOT NULL CHECK (to_phase IN ('Q','RQ','QF','SF','F','RESULT')),
    to_group   INTEGER NOT NULL,                       -- in Finals: 1 = Final, 2 = Small Final
    to_slot    INTEGER NOT NULL,                       -- start position in target heat
    PRIMARY KEY (rule_id, from_phase, from_group, from_rank)
);
-- A target start slot can only be filled once per rule. RESULT lines are
-- exempt: several sources may feed the same final-classification pool
-- (to_group = base rank of the pool, to_slot = 0), ordered by TT time.
-- (Partial index is SQLite syntax; enforce in application code on MariaDB.)
CREATE UNIQUE INDEX uq_rule_target ON progression_rule_step
    (rule_id, to_phase, to_group, to_slot) WHERE to_phase <> 'RESULT';

-- ============================================================================
-- 4. Event
-- ============================================================================
CREATE TABLE event (
    event_id       TEXT PRIMARY KEY,                   -- uuid
    competition_id TEXT NOT NULL REFERENCES competition(competition_id) ON DELETE CASCADE,
    event_code     TEXT NOT NULL,                      -- short code, e.g. 'KXM', 'KXW-U18'
    event_name     TEXT NOT NULL,                      -- e.g. 'Kayak Cross Men'
    gates          INTEGER NOT NULL CHECK (gates BETWEEN 1 AND 8),
    rule_id        TEXT REFERENCES progression_rule(rule_id),   -- progression system in use
    current_phase  TEXT CHECK (current_phase IN ('TT','Q','RQ','QF','SF','F','RESULT')),
                                                       -- currently ACTIVE phase (live state),
                                                       -- not "the" phase of the event
    current_group  INTEGER,                            -- currently active heat within the phase
    live_tracking  INTEGER NOT NULL DEFAULT 0 CHECK (live_tracking IN (0,1)),
                                                       -- when 1, current_phase/current_group are
                                                       -- kept mirroring whatever phase/heat the
                                                       -- Chief currently has open on the Phase
                                                       -- page (see index.html) — no separate "set
                                                       -- active" action needed. When 0, both are
                                                       -- cleared and Gate Judge pages show "waiting".
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (competition_id, event_code)
);

-- ============================================================================
-- 5. Event entries (snapshot of athlete data at this event)
-- ============================================================================
-- Name/club/country are copied here on upload so official results remain
-- historically correct even if the athlete master record changes later.
CREATE TABLE event_athlete (
    event_id           TEXT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    athlete_id         TEXT NOT NULL REFERENCES athlete(athlete_id),
    bib                TEXT NOT NULL,                  -- TEXT: allows colour bibs / leading zeros.
                                                       -- NOT used for ordering (see list_order) —
                                                       -- this lets the same bib be reused across
                                                       -- different events for an athlete entered
                                                       -- in more than one (bib is only unique
                                                       -- WITHIN an event, per the UNIQUE below).
    list_order         INTEGER NOT NULL,               -- position in the uploaded/entered athlete
                                                       -- list for this event; drives the initial
                                                       -- Time Trial start order (see
                                                       -- POST /api/phase/start-tt). Assigned
                                                       -- sequentially as athletes are added;
                                                       -- unrelated to bib.
    first_name         TEXT NOT NULL,
    first_name_initial TEXT,                           -- derived, kept for streaming layouts
    last_name          TEXT NOT NULL,
    club               TEXT,
    country            TEXT CHECK (country IS NULL OR length(country) = 3),
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (event_id, athlete_id),
    UNIQUE (event_id, bib)
);

-- ============================================================================
-- 6. Results
-- ============================================================================
-- One row per athlete per phase (per heat). Created when the start list of
-- a phase is generated (manually or by applying the progression rule).
CREATE TABLE result (
    result_id  TEXT PRIMARY KEY,                       -- uuid
    event_id   TEXT NOT NULL REFERENCES event(event_id) ON DELETE CASCADE,
    athlete_id TEXT NOT NULL REFERENCES athlete(athlete_id),
    phase      TEXT NOT NULL CHECK (phase IN ('TT','Q','RQ','QF','SF','F','RESULT')),
    group_no   INTEGER NOT NULL DEFAULT 1,             -- heat number; TT uses 1
    slot_no    INTEGER NOT NULL,                       -- start position within the heat
    time_ms    INTEGER,                                -- Time Trial time; also usable elsewhere.
                                                       -- Needed as tie-breaker for DNS/DNF/FLT.
                                                       -- Under split-time TT timing (see
                                                       -- competition.tt_start_interval_ms) this is
                                                       -- the CALCULATED actual run time, derived
                                                       -- automatically from split_time_ms — not
                                                       -- entered directly. Otherwise entered directly
                                                       -- as always.
    split_time_ms INTEGER,                             -- raw shared-stopwatch reading at the finish
                                                       -- line, TT phase only, only meaningful when
                                                       -- the competition has split-time timing
                                                       -- configured. See lib/tt-timing.js for the
                                                       -- time_ms = split_time_ms - start_offset
                                                       -- calculation. Kept alongside time_ms (rather
                                                       -- than overwriting it) so the raw reading
                                                       -- stays available for verification/audit.
    finish_pos INTEGER,                                -- raw crossing-the-line order (1st, 2nd...)
                                                       -- as observed by the Chief or a finish-line
                                                       -- Gate Judge. Distinct from `rank`: Auto-rank
                                                       -- combines this with penalties/status to
                                                       -- compute the official rank. Persisted (not
                                                       -- just a UI field) so it survives table
                                                       -- reloads triggered by unrelated changes
                                                       -- (e.g. a Gate Judge penalty elsewhere).
    rank       INTEGER,                                -- rank within the heat; EDITABLE by the
                                                       -- Chief of Scoring; progression is applied
                                                       -- from this value after saving
    status     TEXT CHECK (status IN ('DNS','DNF','DSQ')),
                                                       -- whole-run statuses. FLT/RAL are per-gate
                                                       -- and live in result_penalty below.
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (event_id, phase, athlete_id),              -- athlete appears once per phase
    UNIQUE (event_id, phase, group_no, slot_no)        -- one athlete per start slot
);
CREATE INDEX idx_result_heat ON result(event_id, phase, group_no);

-- Per-gate penalties, append-only (audit trail for protests/enquiries).
-- The "current" penalty of a gate = latest non-revoked row for that gate.
-- Convenience views can flatten this back to gate1..gate8 for the UI/PDFs.
CREATE TABLE result_penalty (
    penalty_id TEXT PRIMARY KEY,                       -- uuid
    result_id  TEXT NOT NULL REFERENCES result(result_id) ON DELETE CASCADE,
    gate_no    INTEGER NOT NULL CHECK (gate_no BETWEEN 1 AND 8),
    penalty    TEXT NOT NULL CHECK (penalty IN ('FLT','RAL')),
    issued_by  TEXT NOT NULL,                          -- 'gate-judge:3', 'chief', ...
    issued_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    revoked_at TEXT,                                   -- set instead of deleting (audit trail)
    revoked_by TEXT
);
CREATE INDEX idx_penalty_result ON result_penalty(result_id, gate_no);

-- Flattened "current penalties" view for easy consumption by UI / PDF / sync.
CREATE VIEW v_result_gates AS
SELECT
    r.result_id,
    MAX(CASE WHEN p.gate_no = 1 THEN p.penalty END) AS gate1,
    MAX(CASE WHEN p.gate_no = 2 THEN p.penalty END) AS gate2,
    MAX(CASE WHEN p.gate_no = 3 THEN p.penalty END) AS gate3,
    MAX(CASE WHEN p.gate_no = 4 THEN p.penalty END) AS gate4,
    MAX(CASE WHEN p.gate_no = 5 THEN p.penalty END) AS gate5,
    MAX(CASE WHEN p.gate_no = 6 THEN p.penalty END) AS gate6,
    MAX(CASE WHEN p.gate_no = 7 THEN p.penalty END) AS gate7,
    MAX(CASE WHEN p.gate_no = 8 THEN p.penalty END) AS gate8
FROM result r
LEFT JOIN result_penalty p
       ON p.result_id = r.result_id AND p.revoked_at IS NULL
GROUP BY r.result_id;

-- ============================================================================
-- 7. Operational tables (audit + website sync)
-- ============================================================================
-- Raw log of every message received from Gate Judge devices (Socket.io).
-- Useful when a penalty is disputed: who sent what, and when.
CREATE TABLE gate_judge_log (
    log_id         TEXT PRIMARY KEY,                   -- uuid
    competition_id TEXT NOT NULL REFERENCES competition(competition_id) ON DELETE CASCADE,
    gate_no        INTEGER,
    device_info    TEXT,                               -- socket id / user agent
    payload        TEXT NOT NULL,                      -- raw JSON message
    received_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Log of synchronisation runs to the public website (MariaDB).
-- The updated_at columns on data tables + last successful finished_at here
-- are enough to implement incremental push ("changed since last sync").
CREATE TABLE sync_log (
    sync_id        TEXT PRIMARY KEY,                   -- uuid
    competition_id TEXT NOT NULL REFERENCES competition(competition_id) ON DELETE CASCADE,
    started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at    TEXT,
    status         TEXT NOT NULL DEFAULT 'RUNNING'
                   CHECK (status IN ('RUNNING','OK','FAILED')),
    message        TEXT                                -- error detail / rows pushed
);

-- What each streaming overlay currently shows — the "remote control" state.
-- Exactly one row per stream_key, always. The OBS-facing display pages
-- (stream-startlist.html, stream-results.html) have ONE permanently fixed
-- URL with no query string; they read this table (refreshed live via SSE)
-- to know what to render. The corresponding *-control.html pages are what
-- the streaming operator actually clicks around during the competition —
-- every change there PATCHes this table instead of changing a URL, which
-- is the whole point: a big competition would otherwise need a different
-- OBS Browser Source URL for every heat, which isn't operable in practice.
CREATE TABLE stream_state (
    stream_key TEXT PRIMARY KEY CHECK (stream_key IN ('startlist', 'results')),
    event_id   TEXT REFERENCES event(event_id),
    mode       TEXT CHECK (mode IS NULL OR mode IN ('official', 'heat')),
                                                       -- 'results' stream only
    phase      TEXT,                                  -- 'results' stream, mode='heat' only
    group_no   INTEGER,                                -- 'results' stream, mode='heat' only
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The session-wide "active competition" — one server instance is run by
-- one Chief of Scoring / one organization at a time (results get pushed
-- to a separate central public website, not yet built, which is where
-- multi-organization aggregation happens — not here). Exactly one row,
-- always. The Phase and Setup pages both read this instead of each having
-- their own competition picker, so switching competitions happens in
-- exactly one place (the shared nav selector) and applies everywhere —
-- see the "Start Here" page (start.html) and README for the full
-- rationale. Gate Judge and the streaming control pages deliberately do
-- NOT follow this — they have their own independent competition/PIN
-- selection, since a judge's phone or a streaming PC may reasonably need
-- to point at a different competition than whatever the Chief currently
-- has open.
CREATE TABLE app_state (
    state_key             TEXT PRIMARY KEY CHECK (state_key = 'active'),
    active_competition_id TEXT REFERENCES competition(competition_id),
    updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ============================================================================
-- 8. updated_at maintenance (SQLite triggers; replicate in app code if preferred)
-- ============================================================================
CREATE TRIGGER trg_competition_updated AFTER UPDATE ON competition
BEGIN
    UPDATE competition SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE competition_id = NEW.competition_id;
END;

CREATE TRIGGER trg_event_updated AFTER UPDATE ON event
BEGIN
    UPDATE event SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE event_id = NEW.event_id;
END;

CREATE TRIGGER trg_result_updated AFTER UPDATE ON result
BEGIN
    UPDATE result SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE result_id = NEW.result_id;
END;

CREATE TRIGGER trg_event_athlete_updated AFTER UPDATE ON event_athlete
BEGIN
    UPDATE event_athlete SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE event_id = NEW.event_id AND athlete_id = NEW.athlete_id;
END;

CREATE TRIGGER trg_progression_rule_updated AFTER UPDATE ON progression_rule
BEGIN
    UPDATE progression_rule SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE rule_id = NEW.rule_id;
END;

CREATE TRIGGER trg_stream_state_updated AFTER UPDATE ON stream_state
BEGIN
    UPDATE stream_state SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE stream_key = NEW.stream_key;
END;

CREATE TRIGGER trg_app_state_updated AFTER UPDATE ON app_state
BEGIN
    UPDATE app_state SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE state_key = NEW.state_key;
END;
