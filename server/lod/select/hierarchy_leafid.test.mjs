// F-112 ①: leafIndex 는 리프 번호 0..leafCount-1 을 정확히 한 번씩 가져야 한다(중복·누락이면 'lod:' 오류).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { buildHierarchy, selectLevels, assertHierarchyInput } from './index.mjs';

const { cloud } = generate({ seed: 1, count: 3000 });
const base = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 256 });
const camera = viewpointToCamera({ eye: [0, 120, 140], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 });

// 매번 새 팔진 트리 객체(배열 사본 포함)를 만들어 변조한다.
function copy() {
  const o = base.octree;
  return { ...base, octree: { ...o, leafIndex: o.leafIndex.slice(), boxMin: o.boxMin.slice(), boxMax: o.boxMax.slice() } };
}
const leafNodes = (h) => Array.from(h.octree.leafIndex).flatMap((v, i) => (v >= 0 ? [i] : []));

test('올바른 계층은 통과한다', () => {
  assert.ok(base.octree.leafCount > 2);
  assert.doesNotThrow(() => assertHierarchyInput(copy()));
});

test('리프 번호 중복(두 리프가 같은 번호)은 lod: 오류', () => {
  const h = copy();
  const [a, b] = leafNodes(h);
  h.octree.leafIndex[b] = h.octree.leafIndex[a];
  assert.throws(() => assertHierarchyInput(h), /^Error: lod:/);
  assert.throws(() => selectLevels(h, camera, { thresholdPx: 0.5 }), /^Error: lod:/);
});

test('리프 노드 하나를 -1 로 바꿔 번호가 누락되면 lod: 오류', () => {
  const h = copy();
  h.octree.leafIndex[leafNodes(h)[0]] = -1;
  assert.throws(() => assertHierarchyInput(h), /^Error: lod:/);
  assert.throws(() => selectLevels(h, camera, { thresholdPx: 0.5 }), /^Error: lod:/);
});

test('검증된 계층의 배열을 다른 배열로 바꿔 끼우면 캐시와 무관하게 다시 검사한다', () => {
  const h = copy();
  assert.doesNotThrow(() => assertHierarchyInput(h));
  const bad = h.octree.leafIndex.slice();
  bad[leafNodes(h)[0]] = -1;
  h.octree.leafIndex = bad;
  assert.throws(() => assertHierarchyInput(h), /^Error: lod:/);
});
