import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from './index.mjs';

const scene = generate({ seed: 3, count: 30000 });
const cloud = scene.cloud ?? scene;

test('단계 0 은 원본 전부, 단계가 오를수록 점이 줄고 모두 입력의 부분집합', () => {
  const h = buildHierarchy(cloud, { edge0M: 0.4, levelCount: 4, maxLeafPoints: 1024 });
  assert.equal(h.levels[0].count, cloud.count);
  for (let l = 1; l < 4; l++) assert.ok(h.levels[l].count < h.levels[l - 1].count, `level ${l}`);
  for (const lv of h.levels) {
    assert.equal(new Set(lv.indices).size, lv.count);
    assert.ok(lv.indices.every((i) => i < cloud.count));
    assert.equal(lv.leafStart[lv.leafStart.length - 1], lv.count);
    assert.equal(lv.normals.length, 3 * lv.count);
  }
});
test('리프 구간의 점은 그 리프에 속한다', () => {
  const h = buildHierarchy(cloud, { edge0M: 0.4, levelCount: 3, maxLeafPoints: 1024 });
  const lv = h.levels[2], oc = h.octree;
  const leafOf = new Int32Array(cloud.count);
  for (let k = 0; k < oc.leafCount; k++) for (let s = oc.leafStart[k]; s < oc.leafStart[k + 1]; s++) leafOf[oc.order[s]] = k;
  for (let k = 0; k < oc.leafCount; k++) for (let s = lv.leafStart[k]; s < lv.leafStart[k + 1]; s++) assert.equal(leafOf[lv.indices[s]], k);
});
