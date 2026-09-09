// timy-bridge/lib/validate.js — decide whether an impulse is a real run time.
//
// A finish light gate fires for anything that breaks the beam: the athlete,
// their paddle blade a fraction of a second later, a safety kayak, a spectator
// wading across, a bird. The Timy faithfully reports all of it. This module
// is the gate between "the hardware said something" and "this is a time that
// may be offered as an athlete's Time Trial result".
//
// Two principles:
//
//  1. Nothing is discarded. A rejected impulse is still reported to
//     kx-server with accepted:false and a reason, so it appears in the
//     operator's queue as a flagged line rather than vanishing. If the
//     validator is wrong, the operator can still see the time and use it.
//
//  2. Rejection is never the last word. Validation here is a filter, not an
//     authority: kx-server writes nothing to `result` until the Chief of
//     Scoring confirms the impulse against a named athlete.
//
// The Timy has its own first line of defence — the DTS/DTF channel blocking
// times (see README) — and setting those correctly on the device removes most
// double triggers before they ever reach us. This module assumes they may not
// be set.

'use strict';

const DEFAULTS = {
  // Which info flags may become a result. Memory replays ('m'), deletions
  // ('c','C','d') and ID changes ('n') are bookkeeping, never results.
  accept_info: [' ', 'i', 'x', 't'],

  // Plausible Time Trial run time for a kayak cross course. A time outside
  // this window is almost always a false trigger or a mispaired start.
  min_run_time_ms: 20000,      // 20 s
  max_run_time_ms: 300000,     // 5 min

  // A second impulse on the same channel within this window is the same
  // physical event seen twice (paddle blade following the boat).
  duplicate_window_ms: 3000,

  // Time-of-day mode only: a finish with no preceding start for that bib, or
  // a start older than this, cannot be paired into a run time.
  max_open_run_ms: 900000,     // 15 min

  // Reject a time of day that goes backwards by more than this (the Timy
  // being re-synced mid-session, or midnight rollover handled elsewhere).
  max_backwards_ms: 1000,
};

const REJECT = {
  INFO_FLAG:        'Not an ordinary timing line',
  CHANNEL_IGNORED:  'Channel not used for Time Trial timing',
  NO_BIB:           'No start number on the Timy',
  DUPLICATE:        'Repeat impulse on the same channel',
  TOO_FAST:         'Run time shorter than any plausible run',
  TOO_SLOW:         'Run time longer than any plausible run',
  UNPAIRED_FINISH:  'Finish with no matching start',
  STALE_START:      'Start too old to pair with this finish',
  CLOCK_BACKWARDS:  'Timy clock moved backwards',
};

/**
 * Create a stateful validator.
 *
 * `mode`:
 *   'run_time'   — the Timy sends the elapsed Time Trial time itself
 *                  (RT/TT channels). This is the configuration kx-server
 *                  expects: the value goes straight into result.time_ms.
 *   'time_of_day'— the Timy sends c0/c1 impulses with a time of day; the
 *                  bridge pairs start to finish per bib and computes the run
 *                  time. Supported because Timy programs differ between
 *                  organisers, but it is the fallback, not the default.
 */
function createValidator(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const mode = options.mode ?? 'run_time';

  const lastOnChannel = new Map();   // channel -> { time_ms, at, bib }
  const openStarts = new Map();      // bib -> { time_ms } awaiting a finish
  const usedStarts = new Map();      // bib -> { time_ms } already paired
  let lastTimeOfDay = null;

  // `runTimeMs` is carried even on a rejection whenever we actually computed
  // one (TOO_FAST/TOO_SLOW/DUPLICATE). The operator can then override a
  // wrong threshold from the UI instead of losing a real time — which
  // matters, because a time that never leaves the bridge cannot be recovered.
  function reject(parsed, code, extra, runTimeMs = null) {
    return {
      accepted: false,
      code,
      message: extra ? `${REJECT[code]} — ${extra}` : REJECT[code],
      run_time_ms: runTimeMs,
      parsed,
    };
  }

  function accept(parsed, runTimeMs, note) {
    return { accepted: true, code: null, message: note ?? null,
             run_time_ms: runTimeMs, parsed };
  }

  /**
   * @param {object} parsed  output of protocol.parseTimyLine
   * @returns {{accepted: boolean, code: string|null, message: string|null,
   *            run_time_ms: number|null, parsed: object}}
   */
  function validate(parsed) {
    if (!cfg.accept_info.includes(parsed.info)) {
      return reject(parsed, 'INFO_FLAG', parsed.info_meaning);
    }

    // Duplicate suppression, and it has to be mode-aware.
    //
    // For a TIME OF DAY the reading IS a clock, so two finishes whose readings
    // are milliseconds apart are one boat crossing the line twice — the paddle
    // blade following the hull.
    //
    // For a RUN TIME the reading is an ELAPSED duration, and comparing two of
    // them says nothing about when they arrived. Two athletes finishing 44.28
    // and 44.50 are 220 ms apart as numbers and would look like a duplicate
    // under the same test, even if their runs were ten minutes apart. Here a
    // duplicate is the SAME LINE repeated: same bib, same time, arriving in
    // quick succession.
    const prev = lastOnChannel.get(parsed.channel);
    const dup = prev && (parsed.kind === 'RUN_TIME'
      ? (prev.bib === parsed.bib && prev.time_ms === parsed.time_ms &&
         Date.now() - prev.at <= cfg.duplicate_window_ms)
      : Math.abs(parsed.time_ms - prev.time_ms) <= cfg.duplicate_window_ms);

    if (dup) {
      // Carry a usable time so the operator can still override. In
      // time-of-day mode the first finish consumed the start, so recover it
      // from usedStarts — otherwise a wrongly flagged repeat could never be
      // rescued and a real time would be lost for good.
      let runTimeMs = null;
      if (parsed.kind === 'RUN_TIME') runTimeMs = parsed.time_ms;
      else if (parsed.kind === 'FINISH') {
        const start = usedStarts.get(parsed.bib) ?? openStarts.get(parsed.bib);
        if (start) runTimeMs = parsed.time_ms - start.time_ms;
      }
      return reject(parsed, 'DUPLICATE',
        parsed.kind === 'RUN_TIME'
          ? `identical to the previous ${parsed.channel} line`
          : `${parsed.time_ms - prev.time_ms} ms after the previous ${parsed.channel}`,
        runTimeMs);
    }

    let result;
    if (parsed.kind === 'RUN_TIME') {
      result = validateRunTime(parsed);
    } else if (mode === 'time_of_day' &&
               (parsed.kind === 'START' || parsed.kind === 'FINISH')) {
      result = validateTimeOfDay(parsed);
    } else {
      result = reject(parsed, 'CHANNEL_IGNORED', `channel ${parsed.channel} in ${mode} mode`);
    }

    // Remember the impulse even when rejected: a rejected duplicate must not
    // reset the duplicate window, but a rejected-for-plausibility time still
    // happened on the wire and the next one should be measured against it.
    if (result.code !== 'DUPLICATE') {
      lastOnChannel.set(parsed.channel,
        { time_ms: parsed.time_ms, at: Date.now(), bib: parsed.bib });
    }
    return result;
  }

  function validateRunTime(parsed) {
    if (!parsed.bib || parsed.bib === '0') return reject(parsed, 'NO_BIB');
    if (parsed.time_ms < cfg.min_run_time_ms) {
      return reject(parsed, 'TOO_FAST', `${(parsed.time_ms / 1000).toFixed(2)} s`, parsed.time_ms);
    }
    if (parsed.time_ms > cfg.max_run_time_ms) {
      return reject(parsed, 'TOO_SLOW', `${(parsed.time_ms / 1000).toFixed(2)} s`, parsed.time_ms);
    }
    return accept(parsed, parsed.time_ms);
  }

  function validateTimeOfDay(parsed) {
    if (lastTimeOfDay != null && parsed.time_ms < lastTimeOfDay - cfg.max_backwards_ms) {
      return reject(parsed, 'CLOCK_BACKWARDS');
    }
    lastTimeOfDay = parsed.time_ms;

    if (parsed.kind === 'START') {
      openStarts.set(parsed.bib, { time_ms: parsed.time_ms });
      return { accepted: false, code: null, message: 'start recorded, waiting for finish',
               run_time_ms: null, parsed, pending: true };
    }

    const start = openStarts.get(parsed.bib);
    if (!start) return reject(parsed, 'UNPAIRED_FINISH', `bib ${parsed.bib}`);
    const runTime = parsed.time_ms - start.time_ms;
    if (runTime > cfg.max_open_run_ms) {
      openStarts.delete(parsed.bib);
      return reject(parsed, 'STALE_START', `${Math.round(runTime / 1000)} s since the start impulse`);
    }
    openStarts.delete(parsed.bib);
    usedStarts.set(parsed.bib, start);       // so a repeat finish can still be timed
    if (runTime < cfg.min_run_time_ms) return reject(parsed, 'TOO_FAST', `${(runTime / 1000).toFixed(2)} s`, runTime);
    if (runTime > cfg.max_run_time_ms) return reject(parsed, 'TOO_SLOW', `${(runTime / 1000).toFixed(2)} s`, runTime);
    return accept(parsed, runTime, `paired with start at ${start.time_ms} ms`);
  }

  function reset() {
    lastOnChannel.clear(); openStarts.clear(); usedStarts.clear(); lastTimeOfDay = null;
  }

  return { validate, reset, config: cfg, mode };
}

module.exports = { createValidator, DEFAULTS, REJECT };
