import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhaseThinnerFactory } from './cand_11_phase.mjs';
import { createSpatialThinner } from './index.mjs';

function cloud(n) {
  const p = new Float32Array(3 * n);
  let s = 12345;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 3 * n; i++) p[i] = r() * 10;
  return p;
}

test('위상 0 은 기준과 같다', () => {
  const p = cloud(1000);
  assert.deepEqual(createPhaseThinnerFactory(0)(p).select(137), createSpatialThinner(p).select(137));
});

test('결정적·부분집합·중복 없음·색인 범위', () => {
  const p = cloud(1000);
  for (const ph of [0, 0.25, 0.5, 0.75]) {
    const a = createPhaseThinnerFactory(ph)(p).select(200);
    const b = createPhaseThinnerFactory(ph)(p).select(200);
    assert.deepEqual(a, b);
    assert.equal(a.length, 200);
    assert.equal(new Set(a).size, 200);
    for (const i of a) assert.ok(i >= 0 && i < 1000);
  }
});

test('k >= n 이면 전부, k = 0 이면 빈 배열', () => {
  const p = cloud(50);
  const t = createPhaseThinnerFactory(0.5)(p);
  assert.equal(new Set(t.select(50)).size, 50);
  assert.equal(t.select(80).length, 50);
  assert.equal(t.select(0).length, 0);
});

test('잘못된 위상은 거부', () => {
  assert.throws(() => createPhaseThinnerFactory(1), RangeError);
  assert.throws(() => createPhaseThinnerFactory(-0.1), RangeError);
});
