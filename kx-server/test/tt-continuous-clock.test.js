// test/tt-continuous-clock.test.js — split-time TT timing with ONE stopwatch
// running across every event of the competition.
//
// The default (clock restarted per event) is covered in engine.test.js. What
// is exercised here is the mode where the time shift is the lead-in before
// the first athlete of the FIRST event only and later events' slots carry on
// counting: see competition.tt_continuous_clock and lib/tt-timing.js.
//
// Run:  node --test

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { open, uuid } = require('../lib/db');
const { api } = require('../lib/api');
const {
  ttStartOffsetMs, computeTTResultTimeMs, continuousClockEnabled, ttPriorSlotsByEvent,
} = require('../lib/tt-timing');

const INTERVAL = 60_000;     // 60s between starts
const SHIFT = 300_000;       // 5min lead-in before the very first athlete

// ---------------------------------------------------------------- unit level

test('prior slots accumulate across events in running order', () => {
  const prior = ttPriorSlotsByEvent([
    { event_id: 'A', slot_count: 8 },
    { event_id: 'B', slot_count: 5 },
    { event_id: 'C', slot_count: 3 },
  ]);
  assert.equal(prior.get('A'), 0);    // first event carries the shift alone
  assert.equal(prior.get('B'), 8);
  assert.equal(prior.get('C'), 13);
});

test('an event with no start list yet contributes nothing', () => {
  const prior = ttPriorSlotsByEvent([
    { event_id: 'A', slot_count: 0 },
    { event_id: 'B', slot_count: 4 },
    { event_id: 'C' },                 // slot_count absent entirely
    { event_id: 'D', slot_count: 2 },
  ]);
  assert.equal(prior.get('B'), 0);
  assert.equal(prior.get('C'), 4);
  assert.equal(prior.get('D'), 4);
});

test('start offsets carry straight through the event boundary', () => {
  // Event A has 8 starters, then event B follows on the same clock.
  assert.equal(ttStartOffsetMs(1, INTERVAL, SHIFT, 0), 300_000);   //  5:00  A slot 1
  assert.equal(ttStartOffsetMs(8, INTERVAL, SHIFT, 0), 720_000);   // 12:00  A slot 8
  assert.equal(ttStartOffsetMs(1, INTERVAL, SHIFT, 8), 780_000);   // 13:00  B slot 1
  assert.equal(ttStartOffsetMs(2, INTERVAL, SHIFT, 8), 840_000);   // 14:00  B slot 2
});

test('priorSlots defaults to 0, so the per-event clock is unchanged', () => {
  assert.equal(ttStartOffsetMs(3, INTERVAL, SHIFT),
               ttStartOffsetMs(3, INTERVAL, SHIFT, 0));
});

test('a late split reading resolves to a short run time', () => {
  // Event B slot 2 starts at 14:00 and finishes when the clock reads 14:42.30
  assert.equal(computeTTResultTimeMs(882_300, 2, INTERVAL, SHIFT, 8), 42_300);
});

test('rejects a split earlier than the athlete\'s own start on the shared clock', () => {
  // 6:00 would be a fine reading for event A, but event B's slot 1 hasn't
  // started yet at that point — the reading belongs to another event.
  assert.throws(() => computeTTResultTimeMs(360_000, 1, INTERVAL, SHIFT, 8),
    /before this athlete's start/);
});

test('negative prior slot counts are rejected outright', () => {
  assert.throws(() => ttStartOffsetMs(1, INTERVAL, SHIFT, -1), /Invalid prior slot count/);
});

test('continuousClockEnabled needs split timing configured as well as the flag', () => {
  assert.equal(continuousClockEnabled(
    { tt_start_interval_ms: INTERVAL, tt_time_shift_ms: SHIFT, tt_continuous_clock: 1 }), true);
  assert.equal(continuousClockEnabled(
    { tt_start_interval_ms: INTERVAL, tt_time_shift_ms: SHIFT, tt_continuous_clock: 0 }), false);
  // Flag alone, with no interval/shift, is meaningless rather than enabled.
  assert.equal(continuousClockEnabled(
    { tt_start_interval_ms: null, tt_time_shift_ms: null, tt_continuous_clock: 1 }), false);
  assert.equal(continuousClockEnabled(null), false);
});

// ------------------------------------------------------------- through the API

// A competition with two events on one clock: MXA (8 starters) then MXB (3).
function fixture({ continuous = 1 } = {}) {
  const db = open(':memory:');
  const routes = api(db, () => {});
  const call = (method, path, body, q = {}) => routes[`${method} ${path}`](q, body);

  const compId = uuid();
  db.prepare(`INSERT INTO competition (competition_id, competition_name, start_date,
    end_date, country, gate_judge_pin, tt_start_interval_ms, tt_time_shift_ms,
    tt_continuous_clock) VALUES (?, 'Clock Cup', '2026-07-11', '2026-07-12', 'FIN',
    '1234', ?, ?, ?)`).run(compId, INTERVAL, SHIFT, continuous);

  const events = {};
  for (const [code, n, order] of [['MXA', 8, 1], ['MXB', 3, 2]]) {
    const eventId = uuid();
    db.prepare(`INSERT INTO event (event_id, competition_id, event_code, event_name,
      gates, sort_order) VALUES (?, ?, ?, ?, 6, ?)`).run(eventId, compId, code, code, order);
    for (let i = 1; i <= n; i++) {
      const athleteId = uuid();
      db.prepare(`INSERT INTO athlete (athlete_id, first_name, last_name, country)
        VALUES (?, ?, 'Athlete', 'FIN')`).run(athleteId, `${code}${i}`);
      db.prepare(`INSERT INTO event_athlete (event_id, athlete_id, bib, list_order,
        first_name, first_name_initial, last_name)
        VALUES (?, ?, ?, ?, ?, 'A.', 'Athlete')`)
        .run(eventId, athleteId, String(i), i, `${code}${i}`);
    }
    events[code] = eventId;
  }
  return { db, call, compId, events };
}

const slotRow = (db, eventId, slot) => db.prepare(
  `SELECT * FROM result WHERE event_id = ? AND phase = 'TT' AND slot_no = ?`)
  .get(eventId, slot);

test('the second event continues the clock rather than restarting it', () => {
  const { db, call, events } = fixture();
  call('POST', '/api/phase/start-tt', { event_id: events.MXA });
  call('POST', '/api/phase/start-tt', { event_id: events.MXB });

  // MXA slot 1 starts at 5:00; a 42.30 run finishes at 5:42.30.
  const a1 = slotRow(db, events.MXA, 1);
  call('PATCH', '/api/result', { result_id: a1.result_id, split_time_ms: 342_300 });
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(a1.result_id).time_ms, 42_300);

  // MXB slot 1 starts at 13:00 (5:00 + 8 * 60s) — the same 42.30 run now
  // reads 13:42.30 on the stopwatch that never stopped.
  const b1 = slotRow(db, events.MXB, 1);
  call('PATCH', '/api/result', { result_id: b1.result_id, split_time_ms: 822_300 });
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).time_ms, 42_300);
});

test('per-event clock (the default) restarts the shift for every event', () => {
  const { db, call, events } = fixture({ continuous: 0 });
  call('POST', '/api/phase/start-tt', { event_id: events.MXA });
  call('POST', '/api/phase/start-tt', { event_id: events.MXB });

  // Both events' slot 1 start at 5:00 — MXB gets no credit for MXA's starters.
  const b1 = slotRow(db, events.MXB, 1);
  call('PATCH', '/api/result', { result_id: b1.result_id, split_time_ms: 342_300 });
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).time_ms, 42_300);
});

test('GET /api/tt-clock reports where each event sits on the stopwatch', () => {
  const { call, events } = fixture();
  call('POST', '/api/phase/start-tt', { event_id: events.MXA });
  call('POST', '/api/phase/start-tt', { event_id: events.MXB });

  const a = call('GET', '/api/tt-clock', null, { event_id: events.MXA });
  assert.equal(a.enabled, true);
  assert.equal(a.continuous_clock, true);
  assert.equal(a.prior_slots, 0);
  assert.equal(a.first_slot_offset_ms, 300_000);      //  5:00

  const b = call('GET', '/api/tt-clock', null, { event_id: events.MXB });
  assert.equal(b.prior_slots, 8);
  assert.equal(b.first_slot_offset_ms, 780_000);      // 13:00
});

test('building an earlier event\'s start list corrects the times behind it', () => {
  // The Chief times MXB first and only then creates MXA's start list. Until
  // MXA exists, MXB looks like the first event on the clock; once it does,
  // MXB's times must fall back into place by themselves.
  const { db, call, events } = fixture();
  call('POST', '/api/phase/start-tt', { event_id: events.MXB });

  const b1 = slotRow(db, events.MXB, 1);
  call('PATCH', '/api/result', { result_id: b1.result_id, split_time_ms: 822_300 });
  // Nothing ran before MXB yet, so 13:42.30 reads as a very slow 8:42.30.
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).time_ms, 522_300);

  const r = call('POST', '/api/phase/start-tt', { event_id: events.MXA });
  assert.equal(r.warning, null);
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).time_ms, 42_300);
  // The raw reading is the observation and is never rewritten.
  assert.equal(db.prepare('SELECT split_time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).split_time_ms, 822_300);
});

test('reordering the events moves the times with them', () => {
  const { db, call, compId, events } = fixture();
  call('POST', '/api/phase/start-tt', { event_id: events.MXA });
  call('POST', '/api/phase/start-tt', { event_id: events.MXB });

  const a1 = slotRow(db, events.MXA, 1);
  call('PATCH', '/api/result', { result_id: a1.result_id, split_time_ms: 342_300 });

  // Run MXB first instead: MXA's slot 1 now starts at 8:00 (5:00 + 3 * 60s),
  // so the same 5:42.30 reading would be before its own start and is cleared
  // rather than stored as a wrong time.
  const r = call('POST', '/api/events/reorder',
    { competition_id: compId, event_ids: [events.MXB, events.MXA] });
  assert.match(r.warning, /could not be recalculated/);
  const after = db.prepare('SELECT time_ms, split_time_ms FROM result WHERE result_id = ?')
    .get(a1.result_id);
  assert.equal(after.time_ms, null);
  assert.equal(after.split_time_ms, 342_300);        // observation preserved
});

test('a slot count that shrinks pulls the following events earlier', () => {
  const { db, call, events } = fixture();
  call('POST', '/api/phase/start-tt', { event_id: events.MXA });
  call('POST', '/api/phase/start-tt', { event_id: events.MXB });
  const b1 = slotRow(db, events.MXB, 1);
  call('PATCH', '/api/result', { result_id: b1.result_id, split_time_ms: 822_300 });
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).time_ms, 42_300);

  // MXA's slot 8 is removed, so MXA now spans 7 slots and MXB's slot 1
  // starts a minute earlier, at 12:00 — the same reading is a minute slower.
  call('DELETE', '/api/result', { result_id: slotRow(db, events.MXA, 8).result_id });
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).time_ms, 102_300);
});

test('a gap left by a scratched starter still consumes its slot', () => {
  // Slot 4 of MXA is deleted but slots 5-8 keep their numbers: the clock ran
  // through the empty slot, so MXB must not slide a minute earlier.
  const { db, call, events } = fixture();
  call('POST', '/api/phase/start-tt', { event_id: events.MXA });
  call('POST', '/api/phase/start-tt', { event_id: events.MXB });
  call('DELETE', '/api/result', { result_id: slotRow(db, events.MXA, 4).result_id });

  const b = call('GET', '/api/tt-clock', null, { event_id: events.MXB });
  assert.equal(b.prior_slots, 8);
  assert.equal(b.first_slot_offset_ms, 780_000);     // still 13:00
});

test('settings that contradict the splits on file are refused, not applied', () => {
  const { db, call, compId, events } = fixture();
  call('POST', '/api/phase/start-tt', { event_id: events.MXA });
  call('POST', '/api/phase/start-tt', { event_id: events.MXB });
  const b1 = slotRow(db, events.MXB, 1);
  call('PATCH', '/api/result', { result_id: b1.result_id, split_time_ms: 822_300 });

  // Switching to a per-event clock would put MXB's slot 1 at 5:00, which is
  // fine — but stretching the interval to 10 minutes puts it at 1:25:00,
  // long after this reading. The whole change is rejected.
  assert.throws(() => call('PATCH', '/api/competitions',
    { competition_id: compId, tt_start_interval_ms: 600_000 }),
    /finishing before their own start/);

  const comp = db.prepare('SELECT * FROM competition WHERE competition_id = ?').get(compId);
  assert.equal(comp.tt_start_interval_ms, INTERVAL);   // not saved
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).time_ms, 42_300);              // not touched
});

test('switching the clock mode recalculates every stored time', () => {
  const { db, call, compId, events } = fixture();
  call('POST', '/api/phase/start-tt', { event_id: events.MXA });
  call('POST', '/api/phase/start-tt', { event_id: events.MXB });
  const b1 = slotRow(db, events.MXB, 1);
  call('PATCH', '/api/result', { result_id: b1.result_id, split_time_ms: 822_300 });
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).time_ms, 42_300);

  // Per-event clock: MXB slot 1 goes back to starting at 5:00, so the same
  // 13:42.30 reading now describes an 8:42.30 run.
  call('PATCH', '/api/competitions',
    { competition_id: compId, tt_continuous_clock: false });
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).time_ms, 522_300);

  // ...and back again.
  call('PATCH', '/api/competitions',
    { competition_id: compId, tt_continuous_clock: true });
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(b1.result_id).time_ms, 42_300);
});

test('directly-entered times without a split are left alone', () => {
  // A competition can switch split timing on midway; times typed in before
  // that have no raw reading behind them and must not be rewritten.
  const { db, call, compId, events } = fixture();
  call('POST', '/api/phase/start-tt', { event_id: events.MXA });
  const a1 = slotRow(db, events.MXA, 1);
  db.prepare('UPDATE result SET time_ms = 44_000 WHERE result_id = ?').run(a1.result_id);

  call('PATCH', '/api/competitions',
    { competition_id: compId, tt_time_shift_ms: 120_000 });
  assert.equal(db.prepare('SELECT time_ms FROM result WHERE result_id = ?')
    .get(a1.result_id).time_ms, 44_000);
});

test('a fresh database and a migrated one agree on the new column', () => {
  const fresh = open(':memory:');
  const cols = fresh.prepare('PRAGMA table_info(competition)').all().map(c => c.name);
  assert.ok(cols.includes('tt_continuous_clock'));
  // Default off, so upgrading changes nothing about how existing
  // competitions are timed.
  const id = uuid();
  fresh.prepare(`INSERT INTO competition (competition_id, competition_name, start_date,
    end_date, country, gate_judge_pin) VALUES (?, 'Plain', '2026-07-11', '2026-07-12',
    'FIN', '1234')`).run(id);
  assert.equal(fresh.prepare('SELECT tt_continuous_clock FROM competition WHERE competition_id = ?')
    .get(id).tt_continuous_clock, 0);
});
