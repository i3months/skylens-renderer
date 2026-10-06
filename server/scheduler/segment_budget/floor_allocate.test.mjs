// makeFloorAllocate(T13.T, 결정 0050) 시험: 기준값은 손으로 계산한 숫자다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFloorAllocate, S6_LOW_LEVEL_FLOOR, levelPointTargets } from './index.mjs';

const counts = [312500, 625000, 1250000, 2500000];

test('S6 낮은 수준 보장 비율은 2%', () => assert.equal(S6_LOW_LEVEL_FLOOR, 0.02));

test('2%: 낮은 수준은 원본의 2%, 나머지는 최고 수준', () => {
  assert.deepEqual(makeFloorAllocate(0.02)(counts, 700000), [6250, 12500, 25000, 656250]);
});

test('수준별 비율 배열, 총 예산이 원본 합 이상이면 원본 그대로(사본)', () => {
  assert.deepEqual(makeFloorAllocate([0.01, 0.02, 0.05])(counts, 700000), [3125, 12500, 62500, 621875]);
  const full = makeFloorAllocate(0.02)(counts, 99999999);
  assert.deepEqual(full, counts);
  assert.notEqual(full, counts);
});

test('최고 수준이 원본에 닿으면 남는 예산은 낮은 수준에 돌려준다', () => {
  const o = makeFloorAllocate(0.02)([10, 20, 40, 100], 160);
  assert.equal(o[3], 100);
  assert.ok(o.reduce((s, x) => s + x, 0) <= 160);
  assert.deepEqual(o, [10, 20, 30, 100]);
});

test('예산이 보장 합보다 작아도 합 ≤ total, 수준마다 1 이상 원본 이하', () => {
  for (const total of [4, 5, 10, 100, 1000, 20000, 50000]) {
    const o = makeFloorAllocate(0.02)(counts, total);
    assert.ok(o.reduce((s, x) => s + x, 0) <= total, `total ${total}: ${o}`);
    o.forEach((x, i) => assert.ok(x >= 1 && x <= counts[i]));
  }
});

test('입력 검사', () => {
  const a = makeFloorAllocate(0.02);
  assert.throws(() => a([1, 0], 5), RangeError);
  assert.throws(() => a([1, 2], 1), RangeError);
  assert.throws(() => a([1, 2], 2.5), RangeError);
});

test('이전 배분(원본 비례)과 달라서 최고 수준이 더 받는다', () => {
  const prev = levelPointTargets(counts, 700000);
  const now = makeFloorAllocate(0.02)(counts, 700000);
  assert.ok(now[3] > prev[3]);
});
