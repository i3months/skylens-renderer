// T03.3 조각 경계 상자 시험. 기준값은 명세 §5.1 에서 손으로 계산한 숫자다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssetFormatError } from '../../../contracts/asset/index.mjs';
import { computeBounds, chooseQuantExp, quantizedBox } from './index.mjs';

// 고정 시드 난수(mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isRange = (e) => e instanceof AssetFormatError && e.code === 'range';

test('bounds_contain_all', () => {
  // 범위별로 기대 qexp 가 정해진 조각: [폭(m), 기대 qexp]
  const cases = [
    [10, 10],
    [63.9, 10],
    [70, 9],
    [127.9, 9],
    [130, 8],
    [255.9, 8],
  ];
  const rand = rng(20240607);
  for (const [width, expectK] of cases) {
    for (let rep = 0; rep < 5; rep++) {
      const n = 50 + Math.floor(rand() * 50);
      const pos = new Float32Array(3 * n);
      const base = [rand() * 2000 - 1000, rand() * 2000 - 1000, rand() * 200];
      for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) pos[3 * i + a] = base[a] + rand() * width;
      // 폭을 확실히 쓰도록 양 끝점을 넣는다
      for (let a = 0; a < 3; a++) {
        pos[a] = base[a];
        pos[3 + a] = base[a] + width;
      }
      const { min, max } = computeBounds(pos);
      for (let i = 0; i < n; i++) {
        for (let a = 0; a < 3; a++) {
          assert.ok(pos[3 * i + a] >= min[a] && pos[3 * i + a] <= max[a]);
        }
      }
      const k = chooseQuantExp(min, max);
      assert.equal(k, expectK);
      const box = quantizedBox(min, k);
      const step = 2 ** -k;
      for (let a = 0; a < 3; a++) {
        assert.equal(box.min[a], min[a]);
        assert.equal(box.max[a], min[a] + 65535 * step);
        // 여유 + 실제 범위 = 양자화 상자 범위
        const slack = box.max[a] - max[a];
        const range = max[a] - min[a];
        assert.equal(slack + range, 65535 * step);
      }
      for (let i = 0; i < n; i++) {
        for (let a = 0; a < 3; a++) {
          assert.ok(pos[3 * i + a] >= box.min[a] && pos[3 * i + a] <= box.max[a]);
        }
      }
    }
  }
});

test('quantizedBox 기준값', () => {
  assert.deepEqual(quantizedBox([0, 0, 0], 10), { min: [0, 0, 0], max: [63.9990234375, 63.9990234375, 63.9990234375] });
  assert.deepEqual(quantizedBox([1, -2, 3], 9).max, [1 + 127.998046875, -2 + 127.998046875, 3 + 127.998046875]);
  assert.equal(quantizedBox([0, 0, 0], 8).max[0], 255.99609375);
  assert.throws(() => quantizedBox([0, 0, 0], 11), isRange);
  assert.throws(() => quantizedBox([0, 0, 0], 7), isRange);
  assert.throws(() => quantizedBox([0, 0, 0], 9.5), isRange);
  assert.throws(() => quantizedBox([NaN, 0, 0], 9), isRange);
});

test('chooseQuantExp 경계값과 우선순위', () => {
  const z = [0, 0, 0];
  // 경계값 정확히 65535·2^-k 는 k 로 맞는다
  assert.equal(chooseQuantExp(z, [63.9990234375, 0, 0]), 10);
  assert.equal(chooseQuantExp(z, [127.998046875, 0, 0]), 9);
  assert.equal(chooseQuantExp(z, [255.99609375, 0, 0]), 8);
  // 경계를 한 칸(ulp) 넘으면 한 단계 내려간다
  assert.equal(chooseQuantExp(z, [0, 63.9990234375 + 2 ** -30, 0]), 9);
  assert.equal(chooseQuantExp(z, [0, 0, 127.998046875 + 2 ** -30]), 8);
  // 가장 넓은 축이 정한다
  assert.equal(chooseQuantExp([5, 5, 5], [6, 5 + 100, 5 + 200]), 8);
  assert.equal(chooseQuantExp(z, z), 10);
  // 해당 없음
  assert.throws(() => chooseQuantExp(z, [255.99609375 + 2 ** -20, 0, 0]), isRange);
  assert.throws(() => chooseQuantExp(z, [0, 300, 0]), isRange);
  assert.throws(() => chooseQuantExp(z, [NaN, 0, 0]), isRange);
  assert.throws(() => chooseQuantExp([1, 0, 0], [0, 0, 0]), isRange);
});

test('computeBounds 기준값과 오류', () => {
  const r = computeBounds(new Float32Array([1, 2, 3, -4, 5, 0.5, 2, -7, 9]));
  assert.deepEqual(r, { min: [-4, -7, 0.5], max: [2, 5, 9] });
  assert.deepEqual(computeBounds(new Float64Array([1.25, 2.5, 3.75])), { min: [1.25, 2.5, 3.75], max: [1.25, 2.5, 3.75] });
  assert.throws(() => computeBounds(new Float32Array(0)), isRange);
  assert.throws(() => computeBounds(new Float32Array([1, 2])), isRange);
  assert.throws(() => computeBounds(new Float32Array([1, 2, NaN])), isRange);
  assert.throws(() => computeBounds(new Float64Array([0, Infinity, 0])), isRange);
  assert.throws(() => computeBounds(new Float64Array([0, 0, -Infinity])), isRange);
});
