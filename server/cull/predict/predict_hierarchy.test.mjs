// F-150: predict 의 리프 상자 채우기 전 leafIndex 일대일·유한 상자 검사.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { predictiveMask } from './index.mjs';

const K = { fx: 400, fy: 400, cx: 320, cy: 240 };
const cam = { width: 640, height: 480, K, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 40] };
const state = { camera: cam, velocityMps: [1, 0, 0], angularRadPerS: [0, 0, 0] };
const opts = { horizonS: 1, steps: 2 };
const g = generate({ seed: 3, count: 5000 });
const mk = () => buildHierarchy(g.cloud ?? g, { edge0M: 0.4, levelCount: 3, maxLeafPoints: 512 });
const CULL = /^Error: cull:/;

function leafNodes(o) {
  const r = [];
  for (let i = 0; i < o.nodeCount; i++) if (o.leafIndex[i] >= 0) r.push(i);
  return r;
}

test('양성 대조: 정상 계층은 통과', () => {
  const h = mk();
  assert.equal(predictiveMask(h, state, opts).length, h.octree.leafCount);
});

test('leafIndex 중복 + 빠진 리프는 cull: 오류', () => {
  const h = mk();
  const [a, b] = leafNodes(h.octree);
  h.octree.leafIndex[b] = h.octree.leafIndex[a];
  assert.throws(() => predictiveMask(h, state, opts), CULL);
});

test('leafIndex 가 leafCount 를 넘으면 cull: 오류', () => {
  const h = mk();
  h.octree.leafIndex[leafNodes(h.octree)[0]] = h.octree.leafCount;
  assert.throws(() => predictiveMask(h, state, opts), CULL);
});

test('리프 상자의 ±Infinity 는 cull: 오류', () => {
  for (const [f, val] of [['boxMin', -Infinity], ['boxMax', Infinity], ['boxMin', Infinity], ['boxMax', -Infinity]]) {
    const h = mk();
    h.octree[f][3 * leafNodes(h.octree)[0] + 1] = val;
    assert.throws(() => predictiveMask(h, state, opts), CULL, `${f} ${val}`);
  }
});

test('배열 길이가 nodeCount 보다 짧으면 cull: 오류', () => {
  const h = mk();
  h.octree.boxMax = h.octree.boxMax.slice(0, 3 * h.octree.nodeCount - 3);
  assert.throws(() => predictiveMask(h, state, opts), CULL);
});

test('leafIndex 가 모든 리프를 정확히 한 번씩만 참조하는지 검사: 중복은 cull: 오류', () => {
  const h = mk();
  const leaves = leafNodes(h.octree);
  // 중복은 있지만 빠진 리프는 없도록: 같은 리프를 두 노드에서 참조
  if (leaves.length >= 2) {
    const leaf0 = h.octree.leafIndex[leaves[0]];
    const leaf1 = h.octree.leafIndex[leaves[1]];
    h.octree.leafIndex[leaves[1]] = leaf0; // 리프[0]의 값으로 덮으면 리프[1]은 빠짐
    assert.throws(() => predictiveMask(h, state, opts), CULL);
  }
});

test('levels[0].leafStart 의 길이가 leafCount 와 맞지 않으면 cull: 오류', () => {
  const h = mk();
  if (h.levels && h.levels[0]) {
    h.levels[0].leafStart = h.levels[0].leafStart.slice(0, h.octree.leafCount - 1);
    assert.throws(() => predictiveMask(h, state, opts), CULL);
  }
});
