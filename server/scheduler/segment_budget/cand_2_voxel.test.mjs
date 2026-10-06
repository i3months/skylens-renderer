// 후보 2(복셀 격자 솎기) 시험. 합성 입력만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoxelThinner, allocateVoxel } from './cand_2_voxel.mjs';
import { createSpatialThinner } from './index.mjs';

function cloud(n, seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const p = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    // 판 두 장 + 흩어진 점(밀도가 고르지 않게)
    const r = rnd();
    if (r < 0.6) { p[3 * i] = rnd() * 10; p[3 * i + 1] = rnd() * 4; p[3 * i + 2] = 0; }
    else if (r < 0.9) { p[3 * i] = 2 + rnd(); p[3 * i + 1] = rnd() * 4; p[3 * i + 2] = rnd() * 3; }
    else { p[3 * i] = rnd() * 10; p[3 * i + 1] = rnd() * 4; p[3 * i + 2] = rnd() * 3; }
  }
  return p;
}

// 모턴 순위(기존 솎기의 전체 순서) 기준으로 오름차순인지 본다.
function mortonRank(pos) {
  const all = createSpatialThinner(pos).select(pos.length / 3);
  const rank = new Uint32Array(all.length);
  all.forEach((i, r) => { rank[i] = r; });
  return rank;
}

test('정확히 k 개, 색인 범위 안, 중복 없음, 모턴 순', () => {
  const pos = cloud(5000, 7);
  const t = createVoxelThinner(pos);
  const rank = mortonRank(pos);
  for (const k of [1, 2, 3, 10, 97, 500, 1234, 4000, 4999]) {
    const sel = t.select(k);
    assert.ok(sel instanceof Uint32Array);
    assert.equal(sel.length, k);
    const seen = new Set();
    for (let j = 0; j < k; j++) {
      assert.ok(sel[j] < 5000);
      assert.ok(!seen.has(sel[j]));
      seen.add(sel[j]);
      if (j > 0) assert.ok(rank[sel[j - 1]] < rank[sel[j]]);
    }
  }
});

test('결정적: 같은 입력이면 같은 결과(새 도구·호출 순서와 무관)', () => {
  const pos = cloud(3000, 11);
  const a = createVoxelThinner(pos);
  const b = createVoxelThinner(new Float32Array(pos));
  const a1 = a.select(700);
  a.select(50);
  b.select(2000);
  assert.deepEqual(a.select(700), a1);
  assert.deepEqual(b.select(700), a1);
});

test('k ≥ n 이면 전부(모턴 순), k = 0 이면 빈 배열, 잘못된 k 는 거부', () => {
  const pos = cloud(800, 3);
  const t = createVoxelThinner(pos);
  const full = createSpatialThinner(pos).select(800);
  assert.deepEqual(t.select(800), full);
  assert.deepEqual(t.select(5000), full);
  assert.equal(t.select(0).length, 0);
  assert.throws(() => t.select(-1), RangeError);
  assert.throws(() => t.select(1.5), RangeError);
  assert.throws(() => createVoxelThinner([0, 0, 0]), TypeError);
});

test('겹친 점·한 점·같은 좌표뿐인 점군도 정확히 k 개', () => {
  const same = new Float32Array(3 * 50).fill(1.5);
  const t = createVoxelThinner(same);
  for (const k of [1, 7, 49]) {
    const sel = t.select(k);
    assert.equal(sel.length, k);
    assert.equal(new Set(sel).size, k);
  }
  assert.deepEqual(createVoxelThinner(new Float32Array([1, 2, 3])).select(1), new Uint32Array([0]));
  const dup = new Float32Array(3 * 400);
  for (let i = 0; i < 400; i++) { dup[3 * i] = i % 20; dup[3 * i + 1] = 0; dup[3 * i + 2] = 0; }
  const s = createVoxelThinner(dup).select(100);
  assert.equal(new Set(s).size, 100);
});

test('칸마다 하나라 공간 분포가 고르다: 조밀한 판에 몰리지 않는다', () => {
  const pos = cloud(20000, 5);
  const sel = createVoxelThinner(pos).select(300);
  // 흩어진 점(z>0 이고 세로 판 x∈[2,3] 밖)이 원본 비율(약 10% 중 일부)보다 많이 뽑힌다
  let sparse = 0;
  for (const i of sel) if (pos[3 * i + 2] > 0 && (pos[3 * i] < 2 || pos[3 * i] > 3)) sparse++;
  let src = 0;
  for (let i = 0; i < 20000; i++) if (pos[3 * i + 2] > 0 && (pos[3 * i] < 2 || pos[3 * i] > 3)) src++;
  assert.ok(sparse / 300 > src / 20000);
});

test('allocateVoxel 은 합 ≤ total', () => {
  const t = allocateVoxel([100, 400, 1600, 6400], 1000);
  assert.ok(t.reduce((a, b) => a + b, 0) <= 1000);
});
