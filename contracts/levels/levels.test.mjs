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

// 손으로 쓴 기대표(F-180 ④): 구현 식(arriving > current)을 다시 쓰지 않고 칸마다 직접 적는다.
// 행 = 현재 수준 0..3, 열 = 도착 수준 0..3. 더 높은 수준이 와야 교체, 같거나 낮으면 건너뜀.
const HAND_TABLE = [
  /* 현재 0 */ ['skip', 'replace', 'replace', 'replace'],
  /* 현재 1 */ ['skip', 'skip', 'replace', 'replace'],
  /* 현재 2 */ ['skip', 'skip', 'skip', 'replace'],
  /* 현재 3 */ ['skip', 'skip', 'skip', 'skip'],
];

test('decideArrival: 도착 전(NONE)은 어느 수준이든 first', () => {
  assert.deepEqual([0, 1, 2, 3].map((a) => decideArrival(NONE, a)), ['first', 'first', 'first', 'first']);
});

test('decideArrival: 손으로 쓴 4×4 표와 칸마다 같다(replace 6칸, skip 10칸)', () => {
  let replaces = 0;
  for (let c = 0; c < 4; c++) {
    for (let a = 0; a < 4; a++) {
      assert.equal(decideArrival(c, a), HAND_TABLE[c][a], `현재 ${c} 도착 ${a}`);
      if (HAND_TABLE[c][a] === 'replace') replaces++;
    }
  }
  assert.equal(replaces, 6);
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
