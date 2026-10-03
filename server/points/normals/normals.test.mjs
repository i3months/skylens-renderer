import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNormals } from './index.mjs';
import { PointsError } from '../../../contracts/points/index.mjs';

// 고정 시드 PRNG(mulberry32)
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('무작위 10만 개: 길이 1, 방향 보존, 입력 불변', () => {
  const r = rng(12345), n = 100000;
  const src = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const mag = 10 ** (-3 + 6 * r());
    for (let k = 0; k < 3; k++) src[3 * i + k] = (r() * 2 - 1) * mag + (k === 0 ? mag * 1e-3 : 0);
  }
  const copy = src.slice();
  const { normals, invalid } = normalizeNormals(src);
  assert.equal(invalid.length, 0);
  assert.deepEqual(src, copy);
  let maxErr = 0, minDot = 1;
  for (let i = 0; i < n; i++) {
    const x = normals[3 * i], y = normals[3 * i + 1], z = normals[3 * i + 2];
    maxErr = Math.max(maxErr, Math.abs(Math.hypot(x, y, z) - 1));
    const a = src[3 * i], b = src[3 * i + 1], c = src[3 * i + 2];
    minDot = Math.min(minDot, (x * a + y * b + z * c) / Math.hypot(a, b, c));
    assert.ok(!Number.isNaN(x + y + z));
  }
  assert.ok(maxErr <= 1e-6, `maxErr ${maxErr}`);
  assert.ok(minDot > 0.999999, `minDot ${minDot}`);
});

test('특수값: 0·NaN·Inf·-0·1e-20 은 invalid, 출력 (0,0,0)', () => {
  const src = new Float32Array([
    0, 0, 0,
    NaN, 1, 0,
    Infinity, 0, 0,
    0, -Infinity, 1,
    -0, -0, -0,
    1e-20, 1e-20, 1e-20,
    0, 0, 1,
  ]);
  const { normals, invalid } = normalizeNormals(src);
  assert.deepEqual([...invalid], [0, 1, 2, 3, 4, 5]);
  for (let i = 0; i < 18; i++) assert.ok(Object.is(normals[i], 0));
  assert.deepEqual([...normals.subarray(18)], [0, 0, 1]);
});

test('아주 큰 값 1e30 은 오버플로 없이 정규화', () => {
  const { normals, invalid } = normalizeNormals(new Float32Array([1e30, 0, 0, 3e38, 3e38, 3e38, -2e30, 2e30, 0]));
  assert.equal(invalid.length, 0);
  assert.deepEqual([...normals.subarray(0, 3)], [1, 0, 0]);
  const s = Math.fround(1 / Math.sqrt(3));
  assert.deepEqual([...normals.subarray(3, 6)], [s, s, s]);
  const h = Math.fround(Math.SQRT1_2);
  assert.deepEqual([...normals.subarray(6, 9)], [-h, h, 0]);
});

test('경계: 길이 1e-11 은 유효, 3 의 배수 아니면 size', () => {
  const ok = normalizeNormals(new Float32Array([0, 0, 1e-11]));
  assert.equal(ok.invalid.length, 0);
  assert.deepEqual([...ok.normals], [0, 0, 1]);
  assert.equal(normalizeNormals(new Float32Array(0)).normals.length, 0);
  assert.throws(() => normalizeNormals(new Float32Array(4)), (e) => e instanceof PointsError && e.code === 'size');
});
