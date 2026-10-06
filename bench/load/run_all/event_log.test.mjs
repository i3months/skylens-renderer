import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_EVENTS } from '../../../contracts/load/harness.mjs';
import { checkEventLog, guarded } from './event_log.mjs';
import { simulateClients } from '../clients/index.mjs';

test('fixture log is valid', () => {
  assert.deepEqual(checkEventLog(FIXTURE_EVENTS, 3), []);
});

test('unknown kind', () => {
  assert.deepEqual(checkEventLog([{ id: 0, tMs: 0, kind: 'zap' }], 3), ['event 0: bad kind']);
});

test('client id equal to clients is out of range', () => {
  const log = [{ id: 0, tMs: 0, kind: 'connect' }, { id: 30, tMs: 5, kind: 'close' }];
  assert.deepEqual(checkEventLog(log, 30), ['event 1: bad id']);
});

test('NaN, negative and infinite tMs', () => {
  assert.deepEqual(checkEventLog([{ id: 0, tMs: NaN, kind: 'connect' }], 3), ['event 0: bad tMs']);
  assert.deepEqual(checkEventLog([{ id: 0, tMs: -1, kind: 'connect' }], 3), ['event 0: bad tMs']);
  assert.deepEqual(checkEventLog([{ id: 0, tMs: Infinity, kind: 'connect' }], 3), ['event 0: bad tMs']);
});

test('null and undefined elements', () => {
  assert.deepEqual(checkEventLog([null], 3), ['event 0: event must be an object']);
  assert.deepEqual(checkEventLog([{ id: 0, tMs: 0, kind: 'connect' }, undefined], 3), ['event 1: event must be an object']);
});

test('non-array logs', () => {
  assert.deepEqual(checkEventLog(null, 3), ['event log: not an array']);
  assert.deepEqual(checkEventLog({}, 3), ['event log: not an array']);
  assert.deepEqual(checkEventLog('abc', 3), ['event log: not an array']);
});

test('sparse array hole is a violation', () => {
  const log = [{ id: 0, tMs: 0, kind: 'connect' }, , { id: 1, tMs: 0, kind: 'connect' }]; // eslint-disable-line no-sparse-arrays
  assert.deepEqual(checkEventLog(log, 3), ['event 1: event must be an object']);
});

test('bytes event with NaN bytes', () => {
  const log = [{ id: 0, tMs: 10, kind: 'bytes', bytes: NaN, latencyMs: 5 }];
  assert.deepEqual(checkEventLog(log, 3), ['event 0: bad bytes']);
});

test('multiple messages for one event keep order', () => {
  assert.deepEqual(checkEventLog([{ id: -1, tMs: NaN, kind: 'close' }], 3), ['event 0: bad id', 'event 0: bad tMs']);
});

test('guarded success', () => {
  assert.deepEqual(guarded('scn', () => 42), { value: 42 });
});

test('guarded failure with Error', () => {
  assert.deepEqual(
    guarded('scn', () => { throw new Error('boom'); }),
    { violation: 'scn: bad event log: boom' },
  );
});

test('guarded failure with thrown string', () => {
  assert.deepEqual(
    guarded('scn', () => { throw 'oops'; }), // eslint-disable-line no-throw-literal
    { violation: 'scn: bad event log: oops' },
  );
});

test('reversed log reports tMs going backwards, not close without connect', () => {
  const log = [{ id: 0, tMs: 20, kind: 'close' }, { id: 0, tMs: 0, kind: 'connect' }];
  assert.deepEqual(checkEventLog(log, 3), ['event 1: tMs goes backwards']);
});

test('equal tMs is allowed; invalid tMs does not reset the monotonic baseline', () => {
  const ok = [{ id: 0, tMs: 5, kind: 'connect' }, { id: 1, tMs: 5, kind: 'connect' }];
  assert.deepEqual(checkEventLog(ok, 3), []);
  const log = [{ id: 0, tMs: 10, kind: 'connect' }, { id: 0, tMs: NaN, kind: 'close' }, { id: 1, tMs: 3, kind: 'connect' }];
  assert.deepEqual(checkEventLog(log, 3), ['event 1: bad tMs', 'event 2: tMs goes backwards']);
});

test('simulated logs satisfy the monotonic check', () => {
  const base = { name: 'steady', kind: 'steady', clients: 30, durationS: 10, path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: 10, e: 30, n: 0, u: 100 }] };
  const scenarios = [
    base,
    { ...base, kind: 'burst', burstLevels: 2 },
    { ...base, kind: 'burst', burstLevels: 4 },
    { ...base, kind: 'slow_link', linkBytesPerS: 50000 },
    { ...base, durationS: 1, path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: 1, e: 30, n: 0, u: 100 }] },
  ];
  for (const sc of scenarios) {
    for (let seed = 0; seed < 20; seed++) assert.deepEqual(checkEventLog(simulateClients(sc, { seed }), 30), [], `${sc.kind} ${seed}`);
  }
});

test('throwing getter (Proxy) becomes a violation, not an exception', () => {
  const evil = new Proxy({}, { get() { throw new Error('trap'); } });
  let r;
  assert.doesNotThrow(() => { r = checkEventLog([{ id: 0, tMs: 0, kind: 'connect' }, evil], 3); });
  assert.deepEqual(r, ['event 1: trap']);
  const getter = { get id() { throw new RangeError('getter boom'); }, tMs: 0, kind: 'connect' };
  assert.deepEqual(checkEventLog([getter], 3), ['event 0: getter boom']);
  const nonError = new Proxy({}, { get() { throw 'str'; } }); // eslint-disable-line no-throw-literal
  assert.deepEqual(checkEventLog([nonError], 3), ['event 0: str']);
});

const seq = (...ts) => ts.map((tMs) => ({ id: 0, tMs, kind: 'connect' }));

test('invalid tMs never poisons the monotonic baseline', () => {
  assert.deepEqual(checkEventLog(seq(Infinity, 1), 3), ['event 0: bad tMs']);
  assert.deepEqual(checkEventLog(seq(10, -1, 3), 3), ['event 1: bad tMs', 'event 2: tMs goes backwards']);
});

test('backwards tMs is reported against the last valid value only', () => {
  assert.deepEqual(checkEventLog(seq(0, 20, 5, 10), 3), ['event 2: tMs goes backwards', 'event 3: tMs goes backwards']);
});

test('non-array and null-ish logs are violations, not throws', () => {
  for (const bad of [null, undefined, 5, {}, 'abc']) {
    assert.deepEqual(checkEventLog(bad, 3), ['event log: not an array']);
  }
});
