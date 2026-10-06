import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_EVENTS } from '../../../contracts/load/harness.mjs';
import { checkEventLog, guarded } from './event_log.mjs';

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
