import test from 'node:test';
import assert from 'node:assert/strict';
import { createStratThinner } from './cand_6_strat.mjs';
import { createSpatialThinner } from './index.mjs';

function cloud(n) {
  const p = new Float32Array(3 * n);
  let s = 12345;
  for (let i = 0; i < 3 * n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; p[i] = (s / 4294967296) * 50; }
  return p;
}
const P = cloud(5000);
const mortonRank = (() => { const o = createSpatialThinner(P).select(5000); const r = new Uint32Array(5000); o.forEach((v, i) => { r[v] = i; }); return r; })();

for (const mode of ['jitter', 'hilbert', 'coarse']) {
  test(`${mode}: 결정성·부분집합·색인 범위·모턴 순·중복 없음`, () => {
    const a = createStratThinner(P, { mode }).select(1234);
    const b = createStratThinner(P, { mode }).select(1234);
    assert.deepEqual(a, b);
    assert.equal(a.length, 1234);
    assert.equal(new Set(a).size, 1234);
    for (let i = 0; i < a.length; i++) {
      assert.ok(a[i] < 5000);
      if (i) assert.ok(mortonRank[a[i]] > mortonRank[a[i - 1]]);
    }
  });
  test(`${mode}: k ≥ n 은 전부, k = 0 은 빈 배열, 잘못된 k 는 던짐`, () => {
    const t = createStratThinner(P, { mode });
    assert.equal(t.count, 5000);
    assert.equal(t.select(5000).length, 5000);
    assert.equal(t.select(99999).length, 5000);
    assert.equal(t.select(0).length, 0);
    assert.throws(() => t.select(-1), RangeError);
    assert.throws(() => t.select(1.5), RangeError);
  });
  test(`${mode}: 점 하나·빈 입력`, () => {
    assert.deepEqual([...createStratThinner(new Float32Array([1, 2, 3]), { mode }).select(1)], [0]);
    assert.equal(createStratThinner(new Float32Array(0), { mode }).select(3).length, 0);
  });
}
test('jitter: 구간마다 한 점(k = n-1 에서 중복 없음)', () => {
  const a = createStratThinner(P, { mode: 'jitter' }).select(4999);
  assert.equal(new Set(a).size, 4999);
});
