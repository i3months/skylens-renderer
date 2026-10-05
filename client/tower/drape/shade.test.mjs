// 드레이프 음영 비율(T15.2) 시험: shadeRatio 와 applyRatio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shadeRatio, applyRatio } from './shade.mjs';

test('기준색과 같으면 비율 1', () => {
  assert.equal(shadeRatio([100, 100, 100], [100, 100, 100]), 1);
  assert.equal(shadeRatio([200, 200, 200], [200, 200, 200]), 1);
  assert.equal(shadeRatio([50, 150, 100], [50, 150, 100]), 1);
});

test('절반 밝기면 비율 0.5', () => {
  assert.equal(shadeRatio([50, 50, 50], [100, 100, 100]), 0.5);
  assert.equal(shadeRatio([100, 100, 100], [200, 200, 200]), 0.5);
});

test('기준의 2 배는 1.4 로 제한', () => {
  assert.equal(shadeRatio([200, 200, 200], [100, 100, 100]), 1.4);
  assert.equal(shadeRatio([255, 255, 255], [100, 100, 100]), 1.4);
});

test('검정(0,0,0)은 비율 0', () => {
  assert.equal(shadeRatio([0, 0, 0], [100, 100, 100]), 0);
  assert.equal(shadeRatio([0, 0, 0], [255, 255, 255]), 0);
});

test('baseRgb 평균이 0 이면 비율 1', () => {
  assert.equal(shadeRatio([100, 100, 100], [0, 0, 0]), 1);
  assert.equal(shadeRatio([0, 0, 0], [0, 0, 0]), 1);
});

test('채널 평균이 다르면 평균 기준으로 계산', () => {
  // terrainRgb 평균 = 100, baseRgb 평균 = 100 → 비율 1
  assert.equal(shadeRatio([100, 100, 100], [100, 100, 100]), 1);
  // terrainRgb 평균 = 100 (300/3), baseRgb 평균 = 100 (300/3) → 비율 1
  assert.equal(shadeRatio([80, 100, 120], [80, 100, 120]), 1);
  // terrainRgb 평균 = 100 (300/3), baseRgb 평균 = 50 (150/3) → 비율 2 → 클램프 1.4
  assert.equal(shadeRatio([80, 100, 120], [40, 50, 60]), 1.4);
});

test('applyRatio: 비율을 각 채널에 적용하고 반올림', () => {
  assert.deepEqual(applyRatio([200, 100, 50], 0.5), [100, 50, 25]);
  assert.deepEqual(applyRatio([100, 100, 100], 1), [100, 100, 100]);
  assert.deepEqual(applyRatio([100, 200, 0], 0.5), [50, 100, 0]);
});

test('applyRatio: 상한 255 로 클램프', () => {
  assert.deepEqual(applyRatio([200, 100, 50], 2), [255, 200, 100]);
  assert.deepEqual(applyRatio([200, 150, 100], 1.4), [255, 210, 140]);
  assert.deepEqual(applyRatio([255, 255, 255], 1.4), [255, 255, 255]);
});

test('applyRatio: 하한 0 으로 클램프', () => {
  assert.deepEqual(applyRatio([1, 2, 3], 0), [0, 0, 0]);
  assert.deepEqual(applyRatio([50, 100, 150], 0.1), [5, 10, 15]);
});

test('applyRatio: 반올림 테스트', () => {
  // Math.round: 2.4 → 2, 2.5 → 3 (0.5 는 +∞ 쪽으로, 은행원 반올림 아님), 2.6 → 3
  assert.deepEqual(applyRatio([5, 5, 5], 0.5), [3, 3, 3]); // 2.5 각각
  assert.deepEqual(applyRatio([3, 3, 3], 1), [3, 3, 3]);
});

test('입력 검증: 길이가 3 이 아니면 RangeError', () => {
  assert.throws(() => shadeRatio([100, 100], [100, 100, 100]), RangeError);
  assert.throws(() => shadeRatio([100, 100, 100, 100], [100, 100, 100]), RangeError);
  assert.throws(() => shadeRatio([100, 100, 100], [100, 100]), RangeError);
});

test('입력 검증: null 이면 RangeError', () => {
  assert.throws(() => shadeRatio(null, [100, 100, 100]), RangeError);
  assert.throws(() => shadeRatio([100, 100, 100], null), RangeError);
});

test('입력 검증: 비유한 값이 있으면 RangeError', () => {
  assert.throws(() => shadeRatio([NaN, 100, 100], [100, 100, 100]), RangeError);
  assert.throws(() => shadeRatio([100, 100, 100], [Infinity, 100, 100]), RangeError);
  assert.throws(() => shadeRatio([100, Infinity, 100], [100, 100, 100]), RangeError);
});

test('입력 검증: 범위 밖이면 RangeError', () => {
  assert.throws(() => shadeRatio([-1, 100, 100], [100, 100, 100]), RangeError);
  assert.throws(() => shadeRatio([256, 100, 100], [100, 100, 100]), RangeError);
  assert.throws(() => shadeRatio([100, 100, 100], [-0.1, 100, 100]), RangeError);
  assert.throws(() => shadeRatio([100, 100, 100], [100, 100, 255.1]), RangeError);
});

test('입력 검증: 문자열 등 숫자가 아니면 RangeError', () => {
  assert.throws(() => shadeRatio(['100', '100', '100'], [100, 100, 100]), RangeError);
  assert.throws(() => shadeRatio([100, 100, 100], [100, '100', 100]), RangeError);
});

test('채널 평균의 비율이지 채널별 비율의 평균이 아니다', () => {
  // 채널 평균 50 ÷ 100 = 0.5. 채널별 비율의 평균이면 (150/50 + 0/100 + 0/150) / 3 = 1.0 이 된다.
  assert.equal(shadeRatio([150, 0, 0], [50, 100, 150]), 0.5);
});

test('경계값: 0 과 255', () => {
  assert.equal(shadeRatio([0, 0, 0], [255, 255, 255]), 0);
  assert.equal(shadeRatio([255, 255, 255], [0, 0, 0]), 1); // baseRgb 평균이 0
});

test('applyRatio: 모서리 값', () => {
  assert.deepEqual(applyRatio([0, 0, 0], 1), [0, 0, 0]);
  assert.deepEqual(applyRatio([255, 255, 255], 1), [255, 255, 255]);
  assert.deepEqual(applyRatio([0, 0, 0], 0), [0, 0, 0]);
});
