// splitCellsByLeaf 비교 함수 경로 테스트: useKey 활성화·비활성화 결과가 바이트 동일한지 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from './index.mjs';

const scene = generate({ seed: 3, count: 30000 });
const cloud = scene.cloud ?? scene;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function randomCloud(n, seed, spread) {
  const r = rng(seed);
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
  for (let i = 0; i < 3 * n; i++) {
    const v = (r() - 0.5) * spread;
    positions[i] = seed % 2 ? Math.round(v * 4) / 4 : v;
    normals[i] = r() - 0.5; colors[i] = (r() * 256) | 0;
  }
  return { format: 1, count: n, positions, normals, colors };
}

test('useKey 활성화와 비활성화 결과가 바이트 동일: terrain 30000 점', () => {
  const h1 = buildHierarchy(cloud, { edge0M: 0.4, levelCount: 4, maxLeafPoints: 1024 });
  const h2 = buildHierarchy(cloud, { edge0M: 0.4, levelCount: 4, maxLeafPoints: 1024, _forceNoKey: true });

  assert.equal(h1.levels.length, h2.levels.length);
  for (let l = 0; l < h1.levels.length; l++) {
    const lv1 = h1.levels[l], lv2 = h2.levels[l];
    assert.equal(lv1.count, lv2.count, `level ${l} count`);
    assert.deepEqual(Array.from(lv1.indices), Array.from(lv2.indices), `level ${l} indices`);
    assert.deepEqual(new Float32Array(lv1.positions), new Float32Array(lv2.positions), `level ${l} positions`);
    assert.deepEqual(new Float32Array(lv1.normals), new Float32Array(lv2.normals), `level ${l} normals`);
    assert.deepEqual(new Uint8Array(lv1.colors), new Uint8Array(lv2.colors), `level ${l} colors`);
    assert.deepEqual(Array.from(lv1.leafStart), Array.from(lv2.leafStart), `level ${l} leafStart`);
  }
});

for (const [n, seed, spread, e0m, mLeafPoints] of [
  [1, 1, 10, 0.5, 8], [500, 2, 20, 0.5, 16], [3000, 3, 30, 0.7, 64], [4000, 4, 5, 0.25, 32], [6000, 7, 100, 1, 50],
]) {
  test(`useKey 동등성: n=${n} seed=${seed}`, () => {
    const cloud = randomCloud(n, seed, spread);
    const edge0M = e0m, levelCount = 4, maxLeafPoints = mLeafPoints;

    const h1 = buildHierarchy(cloud, { edge0M, levelCount, maxLeafPoints });
    const h2 = buildHierarchy(cloud, { edge0M, levelCount, maxLeafPoints, _forceNoKey: true });

    assert.equal(h1.levels.length, h2.levels.length);
    for (let l = 0; l < h1.levels.length; l++) {
      const lv1 = h1.levels[l], lv2 = h2.levels[l];
      assert.equal(lv1.count, lv2.count, `level ${l} count`);
      assert.deepEqual(Array.from(lv1.indices), Array.from(lv2.indices), `level ${l} indices`);
      assert.deepEqual(new Float32Array(lv1.positions), new Float32Array(lv2.positions), `level ${l} positions`);
      assert.deepEqual(new Float32Array(lv1.normals), new Float32Array(lv2.normals), `level ${l} normals`);
      assert.deepEqual(new Uint8Array(lv1.colors), new Uint8Array(lv2.colors), `level ${l} colors`);
    }
  });
}
