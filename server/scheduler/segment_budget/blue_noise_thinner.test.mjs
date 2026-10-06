// 후보 9(푸아송 원반 근사 솎기) 시험: 결정성·부분집합·색인 범위·모턴 순·k ≥ n 처리·최소 거리.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlueNoiseThinner, createThinner } from './blue_noise_thinner.mjs';
import { createSpatialThinner } from './index.mjs';

function scene(n, seed = 7) {
  const p = new Float32Array(3 * n);
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) { p[3 * i] = 10 * rnd(); p[3 * i + 1] = 5 * rnd(); p[3 * i + 2] = 10; } // 벽
    else { p[3 * i] = 50 * rnd(); p[3 * i + 1] = 0; p[3 * i + 2] = 50 * rnd(); } // 바닥
  }
  return p;
}

function minDist(p, sel) {
  let best = Infinity;
  for (let a = 0; a < sel.length; a++) for (let b = a + 1; b < sel.length; b++) {
    const i = sel[a], j = sel[b];
    const d = Math.hypot(p[3 * i] - p[3 * j], p[3 * i + 1] - p[3 * j + 1], p[3 * i + 2] - p[3 * j + 2]);
    if (d < best) best = d;
  }
  return best;
}

test('결정성: 같은 입력·같은 k 는 요청 순서와 무관하게 같은 결과', () => {
  const p = scene(20000);
  const a = createThinner(p);
  const b = createThinner(p);
  const ka = [3000, 500, 7000].map((k) => a.select(k));
  const kb = [7000, 3000, 500].map((k) => b.select(k));
  assert.deepEqual(ka[0], kb[1]);
  assert.deepEqual(ka[1], kb[2]);
  assert.deepEqual(ka[2], kb[0]);
  assert.deepEqual(a.select(3000), ka[0]);
});

test('부분집합·색인 범위·중복 없음·정확히 k 개·모턴 순', () => {
  const n = 20000;
  const p = scene(n);
  const t = createBlueNoiseThinner(p);
  const rank = new Uint32Array(n);
  createSpatialThinner(p).select(n).forEach((s, r) => { rank[s] = r; });
  for (const k of [1, 2, 37, 1000, 2600, 9999, 19999]) {
    const sel = t.select(k);
    assert.ok(sel instanceof Uint32Array);
    assert.equal(sel.length, k);
    const seen = new Uint8Array(n);
    for (let j = 0; j < k; j++) {
      assert.ok(sel[j] < n);
      assert.equal(seen[sel[j]], 0);
      seen[sel[j]] = 1;
      if (j > 0) assert.ok(rank[sel[j - 1]] < rank[sel[j]]);
    }
  }
});

test('k ≥ n 이면 전부(모턴 순), k = 0 이면 빈 배열, 잘못된 k 는 RangeError', () => {
  const p = scene(500);
  const t = createThinner(p);
  const all = createSpatialThinner(p).select(500);
  assert.deepEqual(t.select(500), all);
  assert.deepEqual(t.select(10000), all);
  assert.equal(t.select(0).length, 0);
  assert.throws(() => t.select(-1), RangeError);
  assert.throws(() => t.select(1.5), RangeError);
  assert.throws(() => createThinner(new Float32Array(4)), TypeError);
});

test('같은 점·한 점·퇴화 입력도 k 개를 돌려준다', () => {
  const same = new Float32Array(300).fill(1.25);
  const t = createThinner(same);
  assert.equal(t.select(40).length, 40);
  assert.equal(createThinner(new Float32Array([1, 2, 3])).select(1).length, 1);
  const dup = scene(2000);
  const twice = new Float32Array(2 * dup.length);
  twice.set(dup); twice.set(dup, dup.length);
  assert.equal(new Set(createThinner(twice).select(3500)).size, 3500);
});

test('최소 거리가 모턴 등간격보다 크다(블루노이즈 성질)', () => {
  const p = scene(20000);
  const k = 800;
  const blue = minDist(p, createThinner(p).select(k));
  const stride = minDist(p, createSpatialThinner(p).select(k));
  assert.ok(blue > 2 * stride, `blue ${blue} vs stride ${stride}`);
});

test('출력 사본: 돌려받은 배열을 고쳐도 다음 결과가 바뀌지 않는다', () => {
  const p = scene(3000);
  const t = createThinner(p);
  const a = t.select(400);
  const copy = a.slice();
  a.fill(0);
  assert.deepEqual(t.select(400), copy);
});
