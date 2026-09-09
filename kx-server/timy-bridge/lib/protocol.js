// timy-bridge/lib/protocol.js — ALGE Timy3 ASCII line parser.
//
// Wire format (see alge-timy-interface.md):
//
//     yNNNN_CCC_HH:MM:SS.zhtq_GGRRRR(CR)
//
//     y      info flag: blank = ordinary valid time, or a letter (see INFO)
//     NNNN   start number (bib), up to 4 digits, leading zeros may be absent
//     CCC    channel: c0/c0M start, c1/c1M finish, c2..c8, or RT/TT/SQ/kmh
//     HH:MM:SS.zhtq  time to 1/10,000 s
//     GG     group / lap (often "00")
//     RRRR   rank, only in the classement menu
//
// Real output is looser than the spec sheet: the fraction is sometimes 3
// digits ("15:43:57.020"), the channel field is padded to a fixed width
// ("c0 " vs "c1M"), and trailing group/rank may be missing entirely. The
// regex below therefore treats whitespace as a separator rather than
// counting columns, and treats group/rank as optional.
//
// Nothing here talks to a serial port — feed it strings, get objects back.
// That makes the protocol testable without hardware, and lets the same
// parser be used against a captured log or a simulator.

'use strict';

// First-character info flag. `valid` marks the flags that represent a real
// timing event we may act on; everything else is bookkeeping the Timy emits
// (memory dumps, deletions, ID changes) and must never become a result.
const INFO = {
  ' ': { valid: true,  meaning: 'valid time' },
  '?': { valid: false, meaning: 'time without valid start number' },
  'm': { valid: false, meaning: 'time replayed from Timy memory' },
  'c': { valid: false, meaning: 'time deleted on the Timy' },
  'C': { valid: false, meaning: 'memo-memory time deleted on the Timy' },
  'd': { valid: false, meaning: 'time deleted due to disqualification' },
  'i': { valid: true,  meaning: 'manually entered on the Timy (INPUT)' },
  'n': { valid: false, meaning: 'changed to a new ID number' },
  'x': { valid: true,  meaning: 'time of day received from another Timy' },
  't': { valid: true,  meaning: 'time with radio correction (TED RX / WTN)' },
};

// Channel classification. START/FINISH lines carry a time OF DAY; RUN_TIME
// lines carry an elapsed time the Timy has already computed. Which one a
// given competition produces depends on the Timy program in use, so the
// bridge supports both and labels every impulse with its kind.
const START_CHANNELS  = ['c0', 'c0m'];
const FINISH_CHANNELS = ['c1', 'c1m'];
const RUN_TIME_CHANNELS = ['rt', 'tt', 'sq'];

const LINE_RE = new RegExp(
  '^(.)' +                                  // info flag (may be a space)
  '\\s*(\\d{1,4})' +                        // bib
  '\\s+([A-Za-z][A-Za-z0-9]{0,3})' +        // channel token
  '\\s+(\\d{1,2}):(\\d{2}):(\\d{2})[.,](\\d{1,4})' +  // HH:MM:SS.zhtq
  '(?:\\s+(\\d{1,2}))?' +                   // group (optional)
  '(?:\\s*(\\d{1,4}))?' +                   // rank (optional)
  '\\s*$'
);

/**
 * Fractional digits are 1/10,000 s, but the field is not always 4 wide
 * ("....020" is 3 digits = 2/100 s, not 20/10000 s), so pad on the right.
 */
function fractionToMs(digits) {
  const tenThousandths = +digits.padEnd(4, '0');
  return tenThousandths / 10;              // may be fractional; caller rounds
}

/**
 * Parse one line from the Timy.
 * @returns {object|null} null for anything that is not a timing line
 *   (banner text, echoed commands, empty keep-alives).
 */
function parseTimyLine(line) {
  const raw = String(line ?? '').replace(/[\r\n]+$/, '');
  if (!raw.trim()) return null;

  const m = LINE_RE.exec(raw);
  if (!m) return null;

  const [, infoChar, bibDigits, channelRaw, hh, mm, ss, frac, group, rank] = m;
  const info = INFO[infoChar] ? infoChar : (infoChar.trim() === '' ? ' ' : infoChar);
  const known = INFO[info] ?? { valid: false, meaning: `unknown info flag "${info}"` };

  const channel = channelRaw.trim();
  const c = channel.toLowerCase();
  const kind = RUN_TIME_CHANNELS.includes(c) ? 'RUN_TIME'
    : START_CHANNELS.includes(c) ? 'START'
    : FINISH_CHANNELS.includes(c) ? 'FINISH'
    : 'OTHER';

  const totalMs = ((+hh * 60 + +mm) * 60 + +ss) * 1000 + fractionToMs(frac);

  return {
    raw,
    info,
    info_meaning: known.meaning,
    info_valid: known.valid,
    bib: String(+bibDigits),               // drop leading zeros: "0014" -> "14"
    channel,
    kind,
    // Milliseconds. For START/FINISH this is a time of day (ms since
    // midnight); for RUN_TIME it is the elapsed time itself. Rounded to whole
    // ms because that is what result.time_ms stores; time_text keeps the full
    // 1/10,000 s reading for the audit trail.
    time_ms: Math.round(totalMs),
    time_text: `${hh}:${mm}:${ss}.${frac}`,
    group: group != null ? +group : null,
    rank: rank != null ? +rank : null,
  };
}

/** Format ms as m:ss.hh, matching the Phase page's `fmt` helper. */
function formatMs(ms) {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.` +
         `${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`;
}

module.exports = {
  parseTimyLine, formatMs, fractionToMs,
  INFO, START_CHANNELS, FINISH_CHANNELS, RUN_TIME_CHANNELS, LINE_RE,
};
