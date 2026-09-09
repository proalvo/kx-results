// timy-bridge/test/bridge.test.js — node --test, no hardware required.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTimyLine } = require('../lib/protocol');
const { classifyPort, listPorts, pickAutoConnect } = require('../lib/discovery');
const { createValidator } = require('../lib/validate');

// --------------------------------------------------------------- protocol
test('parses the sample output from the interface spec', () => {
  const i = parseTimyLine(' 0001 c0  15:43:49.8863 00');
  assert.equal(i.bib, '1');                       // leading zeros dropped
  assert.equal(i.channel, 'c0');
  assert.equal(i.kind, 'START');
  assert.equal(i.info_valid, true);
  assert.equal(i.time_ms, ((15 * 60 + 43) * 60 + 49) * 1000 + 886);
});

test('handles keypad channels and short fractions', () => {
  assert.equal(parseTimyLine(' 0016 c1M 15:43:55.8800 00').kind, 'FINISH');
  // ".020" is 3 digits = 2/100 s, not 20/10000 s
  assert.equal(parseTimyLine(' 0019 c0M 15:43:57.020  00').time_ms % 1000, 20);
});

test('flags memory replays and deletions as not valid', () => {
  assert.equal(parseTimyLine('m0007 c0  15:43:59.9927 00').info_valid, false);
  assert.equal(parseTimyLine('c0023 c1  15:44:15.7847 00').info_valid, false);
  assert.equal(parseTimyLine('i0023 c1  15:44:15.7847 00').info_valid, true);
});

test('non-timing lines parse as null', () => {
  assert.equal(parseTimyLine('TIMY3 V1.23'), null);
  assert.equal(parseTimyLine(''), null);
});

// -------------------------------------------------------------- discovery
test('recognises an ALGE device by USB id', () => {
  assert.equal(classifyPort({ vendorId: '0C4A', productId: '088B' }).confidence, 'timy');
  assert.equal(classifyPort({ manufacturer: 'ALGE-TIMING GmbH' }).confidence, 'timy');
  assert.equal(classifyPort({ vendorId: '0403' }).confidence, 'possible');
  assert.equal(classifyPort({}).confidence, 'unknown');
});

test('auto-connects only when exactly one Timy is present', async () => {
  const fake = list => ({ list: async () => list });

  const one = await listPorts(fake([
    { path: 'COM1' },
    { path: 'COM3', vendorId: '0c4a', productId: '088b', manufacturer: 'ALGE' },
  ]));
  assert.equal(one[0].path, 'COM3');                       // Timy sorts first
  assert.equal(pickAutoConnect(one).port.path, 'COM3');

  const two = await listPorts(fake([
    { path: 'COM3', vendorId: '0c4a', productId: '088b' },
    { path: 'COM4', vendorId: '0c4a', productId: '088b' },
  ]));
  assert.equal(pickAutoConnect(two).port, null);

  // A simulator on a virtual port: offered, never auto-connected.
  const sim = await listPorts(fake([{ path: '/dev/pts/3' }]));
  assert.equal(sim[0].connectable, true);
  assert.equal(pickAutoConnect(sim).port, null);
});

// ------------------------------------------------------------- validation
// An RT line carries the ELAPSED time in the HH:MM:SS field, so a 44.28 s
// run reads 00:00:44.2800 — not a time of day.
const runTime = (bib, ms, ch = 'RT') => {
  const s = Math.floor(ms / 1000);
  const t = `00:${String(Math.floor(s / 60)).padStart(2, '0')}:` +
            `${String(s % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}0`;
  return parseTimyLine(` ${String(bib).padStart(4, '0')} ${ch}  ${t} 00`);
};

test('accepts a plausible run time', () => {
  const v = createValidator();
  const r = v.validate(runTime(14, 44280));
  assert.equal(r.accepted, true);
  assert.equal(r.run_time_ms, 44280);
});

test('rejects implausible times and memory replays', () => {
  const v = createValidator();
  assert.equal(v.validate(runTime(14, 900)).code, 'TOO_FAST');
  assert.equal(v.validate(runTime(15, 600000)).code, 'TOO_SLOW');
  assert.equal(v.validate(parseTimyLine('m0007 RT  00:00:44.2800 00')).code, 'INFO_FLAG');
});

test('suppresses a double trigger on the finish gate', () => {
  const v = createValidator({ mode: 'time_of_day' });
  v.validate(parseTimyLine(' 0014 c0  09:10:00.0000 00'));      // start held
  const first = v.validate(parseTimyLine(' 0014 c1  09:10:44.2800 00'));
  assert.equal(first.accepted, true);
  assert.equal(first.run_time_ms, 44280);
  // paddle blade 300 ms later on the same channel
  const echo = v.validate(parseTimyLine(' 0014 c1  09:10:44.5800 00'));
  assert.equal(echo.code, 'DUPLICATE');
  // ...but it still carries a time, so "Use anyway" can rescue it if the
  // blade was in fact the boat and the first impulse was the spectator.
  assert.equal(echo.run_time_ms, 44580);
});

test('two athletes with similar run times are not duplicates', () => {
  const v = createValidator();                       // run_time mode
  assert.equal(v.validate(runTime(14, 44280)).accepted, true);
  // 220 ms apart as NUMBERS, but a different athlete's separate run. Comparing
  // elapsed durations the way clock readings are compared would reject this.
  const second = v.validate(runTime(15, 44500));
  assert.equal(second.accepted, true, second.message);
  assert.equal(second.run_time_ms, 44500);
});

test('the same run-time line sent twice is a duplicate, and still usable', () => {
  const v = createValidator();
  assert.equal(v.validate(runTime(14, 44280)).accepted, true);
  const repeat = v.validate(runTime(14, 44280));
  assert.equal(repeat.code, 'DUPLICATE');
  assert.equal(repeat.run_time_ms, 44280);           // "Use anyway" stays available
});

test('a finish with no start is flagged, not paired to the wrong athlete', () => {
  const v = createValidator({ mode: 'time_of_day' });
  assert.equal(v.validate(parseTimyLine(' 0021 c1  09:20:44.2800 00')).code, 'UNPAIRED_FINISH');
});

// ------------------------------------------------------------------ config
const config = require('../lib/config');

test('a saved device is found again after its port is renumbered', () => {
  const saved = { port: 'COM3', serial_number: 'ALGE1234', baud: 9600 };
  const ports = [{ path: 'COM5', serial_number: 'ALGE1234' }, { path: 'COM3', serial_number: 'OTHER' }];
  const hit = config.findSaved(saved, ports);
  assert.equal(hit.port.path, 'COM5');              // matched by serial number
  assert.match(hit.reason, /different USB socket/);
});

test('the saved port is used when it is still itself', () => {
  const ports = [{ path: 'COM3', serial_number: 'ALGE1234' }];
  assert.equal(config.findSaved({ port: 'COM3', serial_number: 'ALGE1234' }, ports).port.path, 'COM3');
});

test('an absent saved device connects to nothing rather than guessing', () => {
  const r = config.findSaved({ port: 'COM3', serial_number: 'ALGE1234' },
                             [{ path: 'COM9', serial_number: 'SOMETHINGELSE' }]);
  assert.equal(r.port, null);
  assert.match(r.reason, /not present/);
});

test('no saved port means no reconnect', () => {
  assert.equal(config.findSaved({ port: null }, [{ path: 'COM3' }]).port, null);
});

test('close gives up on a port whose device is gone', async () => {
  const { TimyConnection } = require('../lib/serial');
  // A port that never calls back — exactly what an unplugged device does.
  const Hung = function () {
    return { isOpen: true, open: cb => cb(null), on() {}, close() { /* never calls back */ } };
  };
  const c = new TimyConnection({ SerialPort: Hung });
  c.on('error', () => {});                       // expected: the give-up notice
  await c.open('COM_GONE');
  const started = Date.now();
  await c.close(150);
  assert.ok(Date.now() - started < 1000, 'close must not block the bridge');
});
