import test from 'node:test';
import assert from 'node:assert/strict';
import { pointStats } from './index.mjs';
import { FORMAT_POINT27, FORMAT_GAUSS56, PointsError } from '../../contracts/points/index.mjs';

// Point27Cloud 생성: 형식 1
function makePoint27Cloud(points) {
  const positions = new Float32Array(points.flat());
  const normals = new Float32Array(positions.length); // 더미
  const colors = new Uint8Array(positions.length);    // 더미
  return {
    format: FORMAT_POINT27,
    count: points.length,
    positions,
    normals,
    colors,
  };
}

// Gauss56Cloud 생성: 형식 2
function makeGauss56Cloud(points) {
  const positions = new Float32Array(points.flat());
  const fdc = new Float32Array(positions.length);      // 더미
  const opacity = new Float32Array(points.length);      // 더미
  const scales = new Float32Array(positions.length);    // 더미
  const rotations = new Float32Array(points.length * 4 / 3); // 더미
  return {
    format: FORMAT_GAUSS56,
    count: points.length,
    positions,
    fdc,
    opacity,
    scales,
    rotations,
  };
}

test('27 B 형식, 5 점: 경계 상자·밀도 일치', () => {
  // 점: (0,0,0), (1,0,0), (1,1,0), (0,1,0), (0.5,0.5,0)
  // min: [0, 0, 0], max: [1, 1, 0], area: 1, density: 5/1 = 5
  const cloud = makePoint27Cloud([
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0.5, 0.5, 0],
  ]);

  const stats = pointStats(cloud);
  assert.equal(stats.count, 5);
  assert.equal(stats.format, FORMAT_POINT27);
  assert.deepEqual(stats.min, [0, 0, 0]);
  assert.deepEqual(stats.max, [1, 1, 0]);
  assert.equal(stats.densityPerM2, 5);
});

test('56 B 형식, 4 점: 경계 상자·밀도 일치', () => {
  // 점: (0,0,0), (2,0,0), (2,2,0), (0,2,0)
  // min: [0, 0, 0], max: [2, 2, 0], area: 4, density: 4/4 = 1
  const cloud = makeGauss56Cloud([
    [0, 0, 0],
    [2, 0, 0],
    [2, 2, 0],
    [0, 2, 0],
  ]);

  const stats = pointStats(cloud);
  assert.equal(stats.count, 4);
  assert.equal(stats.format, FORMAT_GAUSS56);
  assert.deepEqual(stats.min, [0, 0, 0]);
  assert.deepEqual(stats.max, [2, 2, 0]);
  assert.equal(stats.densityPerM2, 1);
});

test('빈 점군: count 0, min·max·density null', () => {
  const cloud = makePoint27Cloud([]);
  const stats = pointStats(cloud);
  assert.equal(stats.count, 0);
  assert.equal(stats.format, FORMAT_POINT27);
  assert.equal(stats.min, null);
  assert.equal(stats.max, null);
  assert.equal(stats.densityPerM2, null);
});

test('한 줄 위의 점(면적 0): density null, min·max 정상', () => {
  // 점: (0,0,0), (1,0,0), (2,0,0) — y 방향 폭 0
  // min: [0, 0, 0], max: [2, 0, 0], area: (2-0)*(0-0) = 0, density: null
  const cloud = makePoint27Cloud([
    [0, 0, 0],
    [1, 0, 0],
    [2, 0, 0],
  ]);

  const stats = pointStats(cloud);
  assert.equal(stats.count, 3);
  assert.deepEqual(stats.min, [0, 0, 0]);
  assert.deepEqual(stats.max, [2, 0, 0]);
  assert.equal(stats.densityPerM2, null);
});

test('z 가 다르고 음수인 점군: min·max 의 z 가 정확', () => {
  const stats = pointStats(makePoint27Cloud([
    [0, 0, -5],
    [1, 2, -1],
    [3, 1, -9],
    [2, 4, -2],
  ]));
  assert.deepEqual(stats.min, [0, 0, -9]);
  assert.deepEqual(stats.max, [3, 4, -1]);
});

test('모두 음수인 x·y·z: 첫 점이 아닌 값이 max 가 된다', () => {
  const stats = pointStats(makePoint27Cloud([
    [-9, -9, -9],
    [-1, -2, -3],
    [-5, -4, -6],
  ]));
  assert.deepEqual(stats.min, [-9, -9, -9]);
  assert.deepEqual(stats.max, [-1, -2, -3]);
});

test('NaN 은 위치와 무관하게 PointsError(range) 로 거부', () => {
  for (const pts of [[[NaN, 0, 0], [2, 2, 0]], [[0, 0, 0], [NaN, 2, 0]], [[0, 0, 0], [2, 2, NaN]]]) {
    assert.throws(() => pointStats(makePoint27Cloud(pts)), (e) => e instanceof PointsError && e.code === 'range');
  }
});

test('±Infinity 도 PointsError(range) 로 거부', () => {
  for (const v of [Infinity, -Infinity]) {
    assert.throws(() => pointStats(makePoint27Cloud([[0, 0, 0], [v, 1, 1]])), (e) => e instanceof PointsError && e.code === 'range');
  }
});

test('count 와 positions.length/3 불일치: PointsError(size)', () => {
  const cloud = makePoint27Cloud([[0, 0, 0], [1, 1, 1]]);
  cloud.count = 5;
  assert.throws(() => pointStats(cloud), (e) => e instanceof PointsError && e.code === 'size');
  const odd = makePoint27Cloud([[0, 0, 0]]);
  odd.positions = new Float32Array(4);
  assert.throws(() => pointStats(odd), (e) => e instanceof PointsError && e.code === 'size');
  const empty = makePoint27Cloud([]);
  empty.positions = new Float32Array(3);
  assert.throws(() => pointStats(empty), (e) => e instanceof PointsError && e.code === 'size');
});

test('null·undefined 입력은 TypeError 가 아니라 PointsError', () => {
  for (const v of [null, undefined]) {
    assert.throws(() => pointStats(v), (e) => e instanceof PointsError && !(e instanceof TypeError));
  }
  assert.throws(() => pointStats({ count: 0, format: 1 }), PointsError);
});

test('모두 양수인 z: min 이 0 이 아니라 실제 최솟값', () => {
  const stats = pointStats(makePoint27Cloud([
    [1, 1, 7],
    [2, 3, 4],
    [4, 2, 9],
  ]));
  assert.deepEqual(stats.min, [1, 1, 4]);
  assert.deepEqual(stats.max, [4, 3, 9]);
});
