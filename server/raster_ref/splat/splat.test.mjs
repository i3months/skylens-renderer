// T06.4 점 원판 반경·덮는 픽셀 시험. 기대값은 모두 손계산 리터럴이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splatRadiusPx, splatPixels } from './index.mjs';

const cam = (fx = 754.32) => ({
  width: 640, height: 480,
  K: { fx, fy: fx, cx: 320, cy: 240 },
  R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0],
});

// 손계산: 754.32·0.1/(2·10) = 75.432/20 = 3.7716
test('반경: fx=754.32, sizeM=0.1, d=10 → 3.771600', () => {
  const r = splatRadiusPx(cam(), 10, 0.1);
  assert.ok(Math.abs(r - 3.7716) <= 1e-6, `r=${r}`);
});

test('반경: 깊이 2배 → 반경 절반 (d=20 → 1.885800)', () => {
  const r10 = splatRadiusPx(cam(), 10, 0.1);
  const r20 = splatRadiusPx(cam(), 20, 0.1);
  assert.ok(Math.abs(r20 - 1.8858) <= 1e-6, `r20=${r20}`);
  assert.ok(Math.abs(r20 * 2 - r10) <= 1e-12);
});

// 변이 검출: 틀린 식이 같은 리터럴 시험을 통과하지 못함을 확인한다.
test('변이: d 에 비례하는 식, 2 로 나누지 않는 식은 3.7716 을 내지 못함', () => {
  // 실제 구현: r = fx·s/(2·d) = 754.32·0.1/(2·10) = 3.7716
  assert.ok(Math.abs(splatRadiusPx(cam(), 10, 0.1) - 3.7716) <= 1e-6, '실제 구현은 3.7716');
  const fx = 754.32, s = 0.1, d = 10;
  // d 에 비례하는 돌연변이: fx·s·d/2 = 754.32·0.1·10/2 = 377.16
  const mutProp = (fx * s * d) / 2;
  assert.ok(Math.abs(mutProp - 3.7716) > 1e-6, 'd 비례 돌연변이는 실패');
  // 2 로 나누지 않는 돌연변이: fx·s/d = 754.32·0.1/10 = 7.5432
  const mutNoHalf = (fx * s) / d;
  assert.ok(Math.abs(mutNoHalf - 3.7716) > 1e-6, '2 로 나누지 않는 돌연변이는 실패');
  // d 비례 식은 깊이 2배에 반경이 2배가 되어 절반 관계도 깨진다.
  assert.notEqual((fx * s * 20) / 2 * 2, (fx * s * 10) / 2);
});

test('반경: 입력 검사', () => {
  assert.throws(() => splatRadiusPx(cam(), 0, 0.1), /^Error: raster:/);
  assert.throws(() => splatRadiusPx(cam(), -1, 0.1), /^Error: raster:/);
  assert.throws(() => splatRadiusPx(cam(), NaN, 0.1), /^Error: raster:/);
  assert.throws(() => splatRadiusPx(cam(), 10, 0), /^Error: raster:/);
  assert.throws(() => splatRadiusPx(cam(), 10, Infinity), /^Error: raster:/);
  assert.throws(() => splatRadiusPx(null, 10, 0.1), /^Error: raster:/);
  assert.throws(() => splatRadiusPx(cam(-1), 10, 0.1), /^Error: raster:/);
});

// 손계산: 중심 칸 (5,5) 만 거리 0, 상하좌우 4칸은 거리 1(≤1 이라 포함), 대각은 √2>1 이라 제외.
// 번호 j·10+i: (5,4)=45, (4,5)=54, (5,5)=55, (6,5)=56, (5,6)=65
test('작은 사례 열거: u=5.5, v=5.5, r=1 → 5칸', () => {
  assert.deepEqual([...splatPixels(5.5, 5.5, 1, 10, 10)], [45, 54, 55, 56, 65]);
});

test('반환형은 Int32Array, 번호 오름차순', () => {
  const p = splatPixels(33.3, 21.7, 6.2, 64, 48);
  assert.ok(p instanceof Int32Array);
  for (let k = 1; k < p.length; k += 1) assert.ok(p[k - 1] < p[k]);
});

// π·20² = 1256.637…, 실제 개수 1264 (오차 +0.59%)
test('r=20 원판 개수가 π r² 의 ±2% 이내', () => {
  const n = splatPixels(50, 50, 20, 100, 100).length;
  const area = Math.PI * 400;
  assert.ok(Math.abs(n - area) / area <= 0.02, `n=${n}`);
  assert.equal(n, 1264);
});

// 손계산 (u,v)=(0.2,0.3), r=2: 중심 (0.5,0.5) 거리² 0.13, (1.5,0.5) 1.73, (0.5,1.5) 1.53, (1.5,1.5) 3.13 → 포함
// (2.5,0.5) 5.33, (0.5,2.5) 4.93 → 제외. 음의 좌표 칸은 화면 밖이라 잘림.
test('가장자리 잘림: 왼쪽 위 모서리', () => {
  assert.deepEqual([...splatPixels(0.2, 0.3, 2, 10, 10)], [0, 1, 10, 11]);
});

test('가장자리 잘림: 오른쪽 아래 모서리, 모든 번호가 화면 안', () => {
  // (9.8,9.7), r=2 → 왼쪽 위와 대칭: (9,9)=99,(8,9)=98,(9,8)=89,(8,8)=88
  assert.deepEqual([...splatPixels(9.8, 9.7, 2, 10, 10)], [88, 89, 98, 99]);
  const big = splatPixels(5, 5, 100, 10, 10);
  assert.equal(big.length, 100);
});

test('화면 완전히 밖이면 빈 배열', () => {
  assert.equal(splatPixels(-10, -10, 2, 10, 10).length, 0);
  assert.equal(splatPixels(15, 5, 1, 10, 10).length, 0);
});

test('최소 1 픽셀: 반경이 작거나 0 이어도 속한 칸 포함', () => {
  // (3.7,2.2), r=0.1: 칸 (3,2) 중심까지 거리 √(0.04+0.09)>0.1 이지만 속한 칸이라 포함 → 2·10+3=23
  assert.deepEqual([...splatPixels(3.7, 2.2, 0.1, 10, 10)], [23]);
  assert.deepEqual([...splatPixels(3.7, 2.2, 0, 10, 10)], [23]);
  assert.deepEqual([...splatPixels(0, 0, 0, 10, 10)], [0]);
});

test('경계 포함(≤): 칸 중심이 정확히 반경 위', () => {
  // (−0.5,0.5), r=1: 칸 (0,0) 중심 (0.5,0.5) 까지 거리 정확히 1 → 포함
  assert.deepEqual([...splatPixels(-0.5, 0.5, 1, 10, 10)], [0]);
});

test('픽셀 입력 검사', () => {
  assert.throws(() => splatPixels(NaN, 0, 1, 10, 10), /^Error: raster:/);
  assert.throws(() => splatPixels(0, Infinity, 1, 10, 10), /^Error: raster:/);
  assert.throws(() => splatPixels(0, 0, -1, 10, 10), /^Error: raster:/);
  assert.throws(() => splatPixels(0, 0, NaN, 10, 10), /^Error: raster:/);
  assert.throws(() => splatPixels(0, 0, 1, 0, 10), /^Error: raster:/);
  assert.throws(() => splatPixels(0, 0, 1, 10, 2.5), /^Error: raster:/);
});
