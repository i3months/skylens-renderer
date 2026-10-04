// server/scheduler/segment_budget 단위 시험(T13.B).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpatialThinner, levelPointTargets, fitSegmentBudget } from './index.mjs';

function grid(side) {
  const p = new Float32Array(3 * side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) { const i = y * side + x; p[3 * i] = x; p[3 * i + 1] = 0; p[3 * i + 2] = y; }
  return p;
}

test('levelPointTargets: 원본 비례 내림, 최소 1, 원본 이하, 예산이 크면 원본 그대로', () => {
  assert.deepEqual(levelPointTargets([100, 200, 400, 800], 750), [50, 100, 200, 400]);
  assert.deepEqual(levelPointTargets([1, 1000], 10), [1, 9]);
  assert.deepEqual(levelPointTargets([3, 5], 100), [3, 5]);
  const c = [10, 20];
  assert.notEqual(levelPointTargets(c, 30), c); // 사본
  for (const t of [levelPointTargets([7, 13, 999, 12345], 1000)]) assert.ok(t.reduce((s, x) => s + x, 0) <= 1000);
  assert.throws(() => levelPointTargets([1, 0], 5), RangeError);
  assert.throws(() => levelPointTargets([1, 2], 1), RangeError);
  assert.throws(() => levelPointTargets([1, 2], 2.5), RangeError);
});

test('createSpatialThinner: 원본 색인의 부분집합(중복 없음), 결정적, k ≥ n 이면 전부', () => {
  const pos = grid(64);
  const t = createSpatialThinner(pos);
  assert.equal(t.count, 4096);
  const a = t.select(1000);
  assert.equal(a.length, 1000);
  assert.equal(new Set(a).size, 1000);
  for (const i of a) assert.ok(i >= 0 && i < 4096);
  assert.deepEqual(createSpatialThinner(pos).select(1000), a);
  const all = t.select(5000);
  assert.equal(all.length, 4096);
  assert.equal(new Set(all).size, 4096);
  assert.equal(t.select(0).length, 0);
  assert.throws(() => t.select(-1), RangeError);
  assert.throws(() => t.select(1.5), RangeError);
  assert.throws(() => createSpatialThinner([0, 0, 0]), TypeError);
  assert.throws(() => createSpatialThinner(new Float32Array([0, NaN, 0])).select(1), RangeError);
});

test('createSpatialThinner: 공간 균일 — 64×64 격자에서 1024 점을 고르면 8×8 블록마다 16 점 근처', () => {
  const pos = grid(64);
  const sel = createSpatialThinner(pos).select(1024);
  const blocks = new Array(64).fill(0);
  for (const i of sel) blocks[Math.floor(pos[3 * i + 2] / 8) * 8 + Math.floor(pos[3 * i] / 8)]++;
  assert.ok(Math.min(...blocks) >= 8 && Math.max(...blocks) <= 24, `블록 점 수 ${Math.min(...blocks)}..${Math.max(...blocks)}`);
  // 대조: 앞에서 1024 개를 자르면(공간 균일 아님) 비는 블록이 생긴다
  const prefix = new Array(64).fill(0);
  for (let i = 0; i < 1024; i++) prefix[Math.floor(pos[3 * i + 2] / 8) * 8 + Math.floor(pos[3 * i] / 8)]++;
  assert.ok(Math.min(...prefix) === 0);
});

test('fitSegmentBudget: 원본이 맞으면 솎지 않는다', () => {
  const r = fitSegmentBudget({ counts: [10, 20, 40, 80], maxBytes: 10_000, measure: (t) => t.reduce((s, k) => s + 5 * k, 0) });
  assert.equal(r.thinned, false);
  assert.deepEqual(r.targets, [10, 20, 40, 80]);
  assert.equal(r.bytes, 750);
});

test('fitSegmentBudget: 실제 바이트가 maxBytes 이하이고 허용 오차(5%) 안이다 — 선형·비선형 측정', () => {
  const counts = [312500, 625000, 1250000, 2500000];
  const cases = [
    (t) => t.reduce((s, k) => s + 7 * k + 200, 0),
    (t) => t.reduce((s, k) => s + Math.round(k * (3 + 6000 / Math.sqrt(k + 1))), 0), // 점이 적을수록 점당 바이트가 큼
  ];
  for (const measure of cases) {
    const r = fitSegmentBudget({ counts, maxBytes: 3_000_000, measure });
    assert.equal(r.thinned, true);
    assert.equal(r.bytes, measure(r.targets));
    assert.ok(r.bytes <= 3_000_000, `${r.bytes}`);
    assert.ok(r.bytes >= 0.95 * 3_000_000 || r.tries.length >= 6, `${r.bytes} tries ${JSON.stringify(r.tries)}`);
    assert.deepEqual(r.targets, levelPointTargets(counts, r.budgetPoints));
  }
});

test('fitSegmentBudget: 추정이 크게 빗나가도(점당 50 B) 맞는 구성을 찾는다', () => {
  const measure = (t) => t.reduce((s, k) => s + 50 * k, 0);
  const r = fitSegmentBudget({ counts: [1000, 2000, 4000, 8000], maxBytes: 100_000, measure });
  assert.ok(r.bytes <= 100_000);
  assert.ok(r.budgetPoints >= 1900);
});

test('fitSegmentBudget: 최소 구성도 넘으면 던지고, 측정 반환이 정수가 아니면 TypeError', () => {
  assert.throws(() => fitSegmentBudget({ counts: [10, 20], maxBytes: 100, measure: () => 1000 }), RangeError);
  assert.throws(() => fitSegmentBudget({ counts: [10, 20], maxBytes: 100, measure: () => 1.5 }), TypeError);
  assert.throws(() => fitSegmentBudget({ counts: [10, 20], maxBytes: 0, measure: () => 1 }), RangeError);
  assert.throws(() => fitSegmentBudget({ counts: [10, 20], maxBytes: 10, measure: null }), TypeError);
  assert.throws(() => fitSegmentBudget({ counts: [10, 20], maxBytes: 10, measure: () => 1, safety: 0 }), RangeError);
});
