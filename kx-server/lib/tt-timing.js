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

'use strict';

/** The shared-clock reading (ms) at which the athlete in this TT slot starts. */
function ttStartOffsetMs(slotNo, startIntervalMs, timeShiftMs) {
  if (!Number.isInteger(slotNo) || slotNo < 1) {
    throw new Error(`Invalid TT slot number: ${slotNo}`);
  }
  return timeShiftMs + (slotNo - 1) * startIntervalMs;
}

/**
 * Convert a raw split-time reading into the athlete's actual result time.
 * Throws if the result would be negative — that means the split time
 * entered is earlier than this athlete's own start, which is impossible
 * and almost always a data-entry mistake (wrong slot, misread stopwatch,
 * or the split was entered before the athlete actually started).
 */
function computeTTResultTimeMs(splitTimeMs, slotNo, startIntervalMs, timeShiftMs) {
  const offset = ttStartOffsetMs(slotNo, startIntervalMs, timeShiftMs);
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

module.exports = { ttStartOffsetMs, computeTTResultTimeMs, splitTimingEnabled };
