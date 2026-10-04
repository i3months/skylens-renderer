import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL_STEPS, LEVEL_COUNT, FINAL_LEVEL, NONE, ACTIONS, decideArrival, assertLevel, assertSegmentId } from './index.mjs';

test('수준 상수 4개 고정', () => {
  assert.deepEqual([...LEVEL_STEPS], [250, 1000, 3500, 7000]);
  assert.equal(LEVEL_COUNT, 4);
  assert.equal(FINAL_LEVEL, 3);
  assert.equal(NONE, -1);
  assert.ok(Object.isFrozen(LEVEL_STEPS));
  assert.throws(() => { 'use strict'; LEVEL_STEPS[0] = 1; });
});

test('decideArrival: first·replace·skip 전 조합', () => {
  for (let a = 0; a < 4; a++) assert.equal(decideArrival(NONE, a), ACTIONS.FIRST);
  for (let c = 0; c < 4; c++) for (let a = 0; a < 4; a++) {
    assert.equal(decideArrival(c, a), a > c ? ACTIONS.REPLACE : ACTIONS.SKIP, `c=${c} a=${a}`);
  }
});

test('입력 검사', () => {
  assert.throws(() => decideArrival(NONE, 4), RangeError);
  assert.throws(() => decideArrival(NONE, -1), RangeError);
  assert.throws(() => decideArrival(NONE, 1.5), TypeError);
  assert.throws(() => decideArrival(7, 1), RangeError);
  assert.throws(() => assertLevel('1'), TypeError);
  assert.throws(() => assertSegmentId(-1), RangeError);
  assert.throws(() => assertSegmentId(2 ** 32), RangeError);
  assert.throws(() => assertSegmentId(NaN), TypeError);
  assertSegmentId(0); assertSegmentId(0xffffffff);
});
