// lib/tt-timing.js — split-time Time Trial timing.
//
// Some competitions time the TT with stopwatches running a single shared
// clock (no per-athlete chronometer): athletes start at a fixed interval
// on that shared clock, offset by a constant "time shift" so athlete 1
// doesn't start exactly at 0:00. At the finish line, whoever's holding the
// stopwatch reads off the raw elapsed time on the SHARED clock (the
// "split") — not the athlete's own run time, since the clock never
// stopped or reset between athletes.
//
// Athlete at TT start slot N (1-indexed) starts when the shared clock
// reads:
//     start_offset(N) = time_shift + (N - 1) * start_interval
//
// Their actual run time is therefore:
//     result_time = split_time - start_offset(N)
//
// Example from the spec: start_interval = 60_000ms (60s),
// time_shift = 300_000ms (5min). Athlete 1 (slot 1) starts at the shared
// clock reading 5:00.00; athlete 2 (slot 2) at 6:00.00; athlete 3 at
// 7:00.00; and so on, one minute apart.
//
// ---------------------------------------------------------------------------
// One clock for the whole session (competition.tt_continuous_clock)
// ---------------------------------------------------------------------------
// A competition normally runs several events' Time Trials back to back. By
// default each event is treated as its own clock: every event's slot 1
// starts at the time shift, as above.
//
// With tt_continuous_clock set, the stopwatch is instead started once and
// left running for the entire session, straight through the event
// boundaries. The time shift is then the lead-in before the very first
// athlete of the FIRST event only; from there the slots simply keep
// counting, so the first athlete of the second event starts one interval
// after the last athlete of the first:
//
//     prior_slots(E)      = total start slots in the events running before E
//     start_offset(E, N)  = time_shift + (prior_slots(E) + N - 1) * start_interval
//
// Worked example — 60s interval, 5min shift, event A with 8 starters
// followed by event B:
//     A slot 1 ->  5:00      (shift)
//     A slot 8 -> 12:00      (shift + 7 * 60s)
//     B slot 1 -> 13:00      (shift + 8 * 60s — the clock did not restart)
//     B slot 2 -> 14:00
// Every athlete's own run time is still split - start_offset, so a split
// read late in the day is a large number: a B slot 2 athlete finishing at
// 14:42.30 ran 42.30.
//
// "Before E" means the organiser's running order — the same order the
// Events list, the Phase page picker and the printed results use
// (event.sort_order, then event_code as tie-break). An event's slot count
// is the highest TT slot number it uses, not the number of athletes in it,
// so a starter who was entered and then scratched still consumes the slot
// the clock ran through.
//
// Because an event's offsets therefore depend on how many athletes ran
// BEFORE it, times derived from splits are recomputed whenever the running
// order, the start lists or these settings change — see recomputeTTTimes in
// lib/api.js. The raw split_time_ms readings are never touched; only the
// derived time_ms is recalculated.

'use strict';

/**
 * The shared-clock reading (ms) at which the athlete in this TT slot starts.
 *
 * priorSlots is the number of start slots consumed by earlier events on the
 * same running clock — 0 (the default) for the first event, and for every
 * event when the clock is restarted per event.
 */
function ttStartOffsetMs(slotNo, startIntervalMs, timeShiftMs, priorSlots = 0) {
  if (!Number.isInteger(slotNo) || slotNo < 1) {
    throw new Error(`Invalid TT slot number: ${slotNo}`);
  }
  if (!Number.isInteger(priorSlots) || priorSlots < 0) {
    throw new Error(`Invalid prior slot count: ${priorSlots}`);
  }
  return timeShiftMs + (priorSlots + slotNo - 1) * startIntervalMs;
}

/**
 * Convert a raw split-time reading into the athlete's actual result time.
 * Throws if the result would be negative — that means the split time
 * entered is earlier than this athlete's own start, which is impossible
 * and almost always a data-entry mistake (wrong slot, misread stopwatch,
 * or the split was entered before the athlete actually started).
 */
function computeTTResultTimeMs(splitTimeMs, slotNo, startIntervalMs, timeShiftMs,
                               priorSlots = 0) {
  const offset = ttStartOffsetMs(slotNo, startIntervalMs, timeShiftMs, priorSlots);
  const result = splitTimeMs - offset;
  if (result < 0) {
    throw new Error(
      `Split time is before this athlete's start (split ${splitTimeMs}ms, ` +
      `start offset ${offset}ms for slot ${slotNo}). Check the split time and slot number.`);
  }
  return result;
}

/** True when both fields are configured (feature enabled for this competition). */
function splitTimingEnabled(competition) {
  return competition != null
    && competition.tt_start_interval_ms != null
    && competition.tt_time_shift_ms != null;
}

/**
 * True when this competition runs ONE clock across all of its events, so the
 * time shift applies to the first event only and later events' offsets carry
 * on from where the previous event left off. Meaningless — and so reported
 * false — unless split-time timing itself is configured.
 */
function continuousClockEnabled(competition) {
  return splitTimingEnabled(competition) && !!competition.tt_continuous_clock;
}

/**
 * Running total of start slots, for events given IN RUNNING ORDER:
 *
 *     [{ event_id, slot_count }, ...]  ->  Map(event_id -> priorSlots)
 *
 * The first event has 0 prior slots, the second has the first's slot count,
 * and so on. Kept here rather than in SQL so the accumulation is testable on
 * its own and so callers can't accidentally feed it an unordered list — the
 * order of the array IS the running order.
 */
function ttPriorSlotsByEvent(eventsInOrder) {
  const out = new Map();
  let running = 0;
  for (const e of eventsInOrder) {
    out.set(e.event_id, running);
    running += e.slot_count ?? 0;
  }
  return out;
}

module.exports = {
  ttStartOffsetMs, computeTTResultTimeMs, splitTimingEnabled,
  continuousClockEnabled, ttPriorSlotsByEvent,
};
