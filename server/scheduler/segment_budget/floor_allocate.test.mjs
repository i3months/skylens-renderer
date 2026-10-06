// makeFloorAllocate(T13.T, 결정 0065) 시험: 기준값은 손으로 계산한 숫자다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFloorAllocate, S6_LOW_LEVEL_FLOOR, levelPointTargets } from './index.mjs';

const counts = [312500, 625000, 1250000, 2500000];

test('S6 낮은 수준 보장 비율은 2%', () => assert.equal(S6_LOW_LEVEL_FLOOR, 0.02));

test('2%: 낮은 수준은 원본의 2%, 나머지는 최고 수준', () => {
  assert.deepEqual(makeFloorAllocate(S6_LOW_LEVEL_FLOOR)(counts, 700000), [6250, 12500, 25000, 656250]);
});

test('수준별 비율 배열, 총 예산이 원본 합 이상이면 원본 그대로(사본)', () => {
  assert.deepEqual(makeFloorAllocate([0.01, 0.02, 0.05])(counts, 700000), [3125, 12500, 62500, 621875]);
  const full = makeFloorAllocate(S6_LOW_LEVEL_FLOOR)(counts, 99999999);
  assert.deepEqual(full, counts);
  assert.notEqual(full, counts);
});

test('최고 수준이 원본에 닿으면 남는 예산은 낮은 수준에 돌려준다', () => {
  const o = makeFloorAllocate(S6_LOW_LEVEL_FLOOR)([10, 20, 40, 100], 160);
  assert.deepEqual(o, [10, 20, 30, 100]);
});

test('입력 검사', () => {
  const a = makeFloorAllocate(S6_LOW_LEVEL_FLOOR);
  assert.throws(() => a([1, 0], 5), RangeError);
  assert.throws(() => a([1, 2], 1), RangeError);
  assert.throws(() => a([1, 2], 2.5), RangeError);
});

test('이전 배분(원본 비례)과 달라서 최고 수준이 더 받는다', () => {
  const prev = levelPointTargets(counts, 700000);
  const now = makeFloorAllocate(S6_LOW_LEVEL_FLOOR)(counts, 700000);
  assert.ok(now[3] > prev[3]);
});

test('frac 검증: NaN·빈 배열·음수·1 초과·배열 속 나쁜 값은 RangeError', () => {
  for (const bad of [NaN, [], -1, 2, Infinity, [0.1, NaN], [0.1, 1.5]]) assert.throws(() => makeFloorAllocate(bad), RangeError, String(bad));
});

test('나누어떨어지지 않는 counts: 내림(floor) 손계산', () => {
  // 낮은 수준: floor(7*0.1)=0→최소 1, floor(13*0.1)=1, floor(99*0.1)=9, 최고 수준은 total 에서 나머지.
  assert.deepEqual(makeFloorAllocate(0.1)([7, 13, 99, 1000], 500), [1, 1, 9, 489]);
});

test('짧은 비율 배열은 마지막 값을 반복한다(0.5, 0.1 → 수준 0 은 0.5, 나머지 낮은 수준은 0.1)', () => {
  assert.deepEqual(makeFloorAllocate([0.5, 0.1])([100, 200, 400, 1000], 500), [50, 20, 40, 390]);
});

test('작은 counts 에서 total 4..합 전 범위: 각 ≥ 1, 원본 이하, 합 ≤ total', () => {
  const c = [10, 20, 40, 100];
  for (let total = 4; total <= 170; total++) {
    const o = makeFloorAllocate(S6_LOW_LEVEL_FLOOR)(c, total);
    assert.ok(o.every((x, i) => x >= 1 && x <= c[i]), `total ${total}: ${o}`);
    assert.ok(o.reduce((s, x) => s + x, 0) <= total, `total ${total}: ${o}`);
  }
});

test('최소 예산(total = 수준 수)은 수준마다 정확히 1 점(Math.max(1, …) 하한)', () => {
  assert.deepEqual(makeFloorAllocate(S6_LOW_LEVEL_FLOOR)([10, 20, 40, 100], 4), [1, 1, 1, 1]);
  assert.deepEqual(makeFloorAllocate(0)([10, 20, 40, 100], 4), [1, 1, 1, 1]);
  assert.deepEqual(makeFloorAllocate(0)([10, 20, 40, 100], 50), [1, 1, 1, 47]);
});

test('비율 배열이 짧을 때 마지막 값을 쓴다(첫 값이 아니다): 수준 2 가 0.1 로 계산됨', () => {
  // 0.9, 0.1: 수준 1·2 는 모두 마지막 값 0.1 → 20, 40. 첫 값(0.9)이면 180, 360.
  assert.deepEqual(makeFloorAllocate([0.9, 0.1])([100, 200, 400, 1000], 800), [90, 20, 40, 650]);
});

test('보장 합 + 1 이상이면 보장 경로, 미만이면 축소 경로: 경계 손계산(S6 counts, 보장 합 43,750)', () => {
  const a = makeFloorAllocate(S6_LOW_LEVEL_FLOOR);
  assert.deepEqual(a(counts, 43751), [6250, 12500, 25000, 1]);
  assert.deepEqual(a(counts, 43752), [6250, 12500, 25000, 2]);
  // 축소: floor(6250·43749/43750)=6249, floor(12500·…)=12499, floor(25000·…)=24999, 최고 수준 1, 남는 1 점은 쓰지 않는다.
  assert.deepEqual(a(counts, 43750), [6249, 12499, 24999, 1]);
  // 극한 축소 경로: 총 예산이 수준 수(4)일 때 모든 수준이 1 이상이어야 한다.
  assert.deepEqual(a(counts, 4), [1, 1, 1, 1]);
});

test('total 이 늘 때 어느 수준의 점 수도 줄지 않는다(보장 경로·축소 경로 모두)', () => {
  const cases = [[[10, 20, 40, 100], S6_LOW_LEVEL_FLOOR, 170], [[7, 13, 99, 1000], 0.1, 1119], [[100, 200, 400, 1000], [0.5, 0.1], 1700], [counts, S6_LOW_LEVEL_FLOOR, 60000]];
  for (const [c, f, max] of cases) {
    const a = makeFloorAllocate(f);
    let prev = null;
    for (let total = c.length; total <= max; total++) {
      const o = a(c, total);
      if (prev) o.forEach((x, i) => assert.ok(x >= prev[i], `counts ${c} total ${total}: ${prev} -> ${o}`));
      prev = o;
    }
  }
});
