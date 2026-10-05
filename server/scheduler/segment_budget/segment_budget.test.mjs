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

// ---- F-303 ①②③⑦ ----
test('F-303 ① 원본 그대로 경로: 원본이 maxBytes 를 넘으면(10,500 B > 10,000 B) 솎고 bytes ≤ maxBytes', () => {
  const measure = (t) => t.reduce((s, k) => s + 70 * k, 0);
  const r = fitSegmentBudget({ counts: [10, 20, 40, 80], maxBytes: 10_000, measure });
  assert.equal(measure([10, 20, 40, 80]), 10_500);
  assert.equal(r.thinned, true);
  assert.ok(r.bytes <= 10_000, `${r.bytes}`);
  assert.ok(r.budgetPoints < 150);
});

test('F-303 ② 허용 오차 안에 닿으면 6 회를 채우지 않고 멈춘다(탈출구 없이 단언)', () => {
  // 점당 정확히 10 B: 첫 시도(maxBytes/5 → 원본 초과 → 비례 보정)가 5% 안에 닿는다
  const measure = (t) => t.reduce((s, k) => s + 10 * k, 0);
  const r = fitSegmentBudget({ counts: [1000, 2000, 4000, 8000], maxBytes: 100_000, measure });
  const last = r.tries[r.tries.length - 1];
  assert.ok(last.bytes <= 100_000 && last.bytes >= 0.95 * 100_000, `${last.bytes}`);
  assert.equal(r.bytes, last.bytes);
  assert.ok(r.tries.length < 6, `시도 ${r.tries.length} 회`);
  // 허용 오차를 0 으로 주면 정확히 맞출 수 없어 더 시도한다(오차 조건이 멈춤을 결정한다는 대조)
  const r0 = fitSegmentBudget({ counts: [1000, 2000, 4000, 8000], maxBytes: 100_000, tolerance: 0, measure: (t) => t.reduce((s, k) => s + 10 * k + 7, 0) });
  assert.ok(r0.tries.length > r.tries.length);
});

test('F-303 ③ 섞은 순서 점군: 모턴 등간격이 블록마다 고르고, 같은 점 수에서 원래 순서 등간격보다 차분 비트가 적다', () => {
  const side = 64;
  const grid0 = grid(side);
  // 결정적 섞기(LCG Fisher–Yates)
  const perm = Array.from({ length: side * side }, (_, i) => i);
  let st = 12345;
  for (let i = perm.length - 1; i > 0; i--) { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; const j = st % (i + 1); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const pos = new Float32Array(grid0.length);
  perm.forEach((src, i) => { pos.set(grid0.subarray(3 * src, 3 * src + 3), 3 * i); });
  const k = 1024;
  const sel = createSpatialThinner(pos).select(k);
  const blocksOf = (idx) => { const b = new Array(64).fill(0); for (const i of idx) b[Math.floor(pos[3 * i + 2] / 8) * 8 + Math.floor(pos[3 * i] / 8)]++; return b; };
  const mb = blocksOf(sel);
  assert.ok(Math.min(...mb) >= 12 && Math.max(...mb) <= 20, `모턴 블록 ${Math.min(...mb)}..${Math.max(...mb)}`);
  const naive = Array.from({ length: k }, (_, j) => Math.floor((j * perm.length) / k)); // 원래 순서 등간격
  const nb = blocksOf(naive);
  assert.ok(Math.max(...nb) - Math.min(...nb) > Math.max(...mb) - Math.min(...mb), '대조: 원래 순서 등간격은 덜 고르다');
  // 같은 점 수에서 연속 점 차분의 비트 수 합(바이트 대리 값): 모턴 순이 더 작다
  const bits = (idx) => { let s = 0; for (let j = 1; j < idx.length; j++) for (let a = 0; a < 3; a++) s += Math.ceil(Math.log2(Math.abs(pos[3 * idx[j] + a] - pos[3 * idx[j - 1] + a]) + 1)); return s; };
  assert.equal(sel.length, naive.length);
  assert.ok(bits(sel) < 0.7 * bits(naive), `모턴 ${bits(sel)} vs 원래 순서 ${bits(naive)}`);
});

test('F-303 ⑦ levelPointTargets 합 ≤ total 과 fitSegmentBudget 인자 검사', () => {
  const t = levelPointTargets([1000000, 1, 1, 1], 4);
  assert.deepEqual(t, [1, 1, 1, 1]);
  for (const [c, total] of [[[1000000, 1, 1, 1], 6], [[5, 1000, 1, 1], 10], [[2, 2, 2, 2], 5], [[1, 1, 1], 3]]) {
    const r = levelPointTargets(c, total);
    assert.ok(r.reduce((s, x) => s + x, 0) <= total, JSON.stringify([c, total, r]));
    assert.ok(r.every((x, i) => x >= 1 && x <= c[i]));
  }
  const base = { counts: [10, 20], maxBytes: 1000, measure: () => 1 };
  for (const maxIter of [0, -1, 1.5, NaN]) assert.throws(() => fitSegmentBudget({ ...base, maxIter }), RangeError, `maxIter ${maxIter}`);
  for (const bytesPerPointGuess of [0, -5, Infinity, NaN]) assert.throws(() => fitSegmentBudget({ ...base, bytesPerPointGuess }), RangeError, `guess ${bytesPerPointGuess}`);
  assert.equal(fitSegmentBudget({ ...base, maxIter: 1 }).thinned, false);
});

test('F-316 ⑤ 넘친 점 예산을 큰 수준부터 깎는 순서 검증', () => {
  // [10, 1, 1, 1] total 7: sum=13, 비례 [5,0,0,0] → 최소 [5,1,1,1] → 넘침 1
  // 큰 것부터 깎으면(정상): 인덱스 0 에서 1 만큼 깎아 [4,1,1,1]
  // 작은 것부터 깎아도 인덱스 1-3 은 깎을 수 없어(최소 1) 결국 같은 결과이므로, 이 사례는 정렬 방향만 못 가린다.
  // 같은 크기 사이의 순서(앞 인덱스 먼저)는 아래 [40,40,...] 시험이 가린다.
  assert.deepEqual(levelPointTargets([10, 1, 1, 1], 7), [4, 1, 1, 1]);
});

test('넘침을 큰 수준부터 덜어낸다: [60,30,1,1,1,1] total 7 → 원본 [1,2,1,1,1,1]', () => {
  // sum=94, 비례 내림 [4,2,0,0,0,0] → 최소 1 보정 [4,2,1,1,1,1] 합 10, 넘침 3.
  // 큰 수준부터(인덱스 0 에서 3) 덜면 [1,2,1,1,1,1]. 오름차순이면 [2,1,1,1,1,1] 이 되어 달라진다.
  assert.deepEqual(levelPointTargets([60, 30, 1, 1, 1, 1], 7), [1, 2, 1, 1, 1, 1]);
});

test('같은 크기 수준은 앞 인덱스부터 덜어낸다: [40,40,1,1,1,1] total 7 → [1,2,1,1,1,1]', () => {
  // sum=84, 비례 내림 [3,3,0,0,0,0] → 최소 1 보정 [3,3,1,1,1,1] 합 10, 넘침 3.
  // 크기가 같으면 앞 인덱스부터: 인덱스 0 에서 2, 인덱스 1 에서 1 → [1,2,1,1,1,1]. 뒤 인덱스부터면 [2,1,1,1,1,1].
  assert.deepEqual(levelPointTargets([40, 40, 1, 1, 1, 1], 7), [1, 2, 1, 1, 1, 1]);
});
