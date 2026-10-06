import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFloorAllocate, makeWeightedAllocate } from './cand_1_alloc.mjs';

const counts = [312500, 625000, 1250000, 2500000];
const allocs = { floor1: makeFloorAllocate(0.01), floor5: makeFloorAllocate(0.05), vec: makeFloorAllocate([0.01, 0.02, 0.05]), w5: makeWeightedAllocate(0.5), w1: makeWeightedAllocate(1) };

for (const [name, a] of Object.entries(allocs)) {
  test(`${name}: 합 ≤ total, 1 ≤ 수준 ≤ 원본, 결정성`, () => {
    for (const total of [4, 5, 100, 1000, 50000, 600000, 2000000, 4000000, 4687500, 9999999]) {
      const o = a(counts, total);
      assert.equal(o.length, counts.length);
      assert.ok(o.reduce((s, x) => s + x, 0) <= Math.max(total, 0) || total >= 4687500);
      o.forEach((x, i) => { assert.ok(Number.isInteger(x) && x >= 1 && x <= counts[i], `${total} ${i} ${x}`); });
      assert.deepEqual(o, a(counts, total));
    }
  });
  test(`${name}: total ≥ 원본 합이면 원본 그대로`, () => {
    assert.deepEqual(a(counts, 4687500), counts);
    assert.deepEqual(a(counts, 99999999), counts);
  });
  test(`${name}: 수준 수 미만 total 은 거부`, () => {
    assert.throws(() => a(counts, 3), RangeError);
  });
}

test('floor: 낮은 수준은 보장 비율, 나머지는 최고 수준', () => {
  const o = makeFloorAllocate(0.02)(counts, 700000);
  assert.deepEqual(o.slice(0, 3), [6250, 12500, 25000]);
  assert.equal(o[3], 700000 - 43750);
});

test('floor: 최고 수준이 원본에 닿으면 남는 예산을 낮은 수준에 돌린다', () => {
  const o = makeFloorAllocate(0.01)([100, 100], 190);
  assert.deepEqual(o, [90, 100]);
});

test('weighted: 낮은 수준일수록 비율이 낮다', () => {
  const o = makeWeightedAllocate(0.5)(counts, 600000);
  const r = o.map((x, i) => x / counts[i]);
  assert.ok(r[0] < r[1] && r[1] < r[2] && r[2] < r[3]);
});

test('잘못된 입력', () => {
  assert.throws(() => makeWeightedAllocate(0), RangeError);
  assert.throws(() => makeFloorAllocate(0.1)([], 5), RangeError);
});
