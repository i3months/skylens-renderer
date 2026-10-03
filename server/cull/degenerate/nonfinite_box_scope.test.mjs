// F-155 ③: 각 컬링 단계가 ±Inf·NaN 상자 좌표를 어디까지 거부하는지 경험적 결정.
// 표 = 단계 × 입력 종류(±Inf 내부 노드·NaN 리프·NaN 내부 노드).
// 관찰 결과에 따라 단계별 정책을 재기록한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { frustumCull } from '../frustum/index.mjs';
import { distanceCull } from '../distance/index.mjs';
import { leafNormalCones, backfaceCull } from '../backface/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../occlusion/index.mjs';
import { leafPriority, orderChunks } from '../priority/index.mjs';
import { cullAndSelect, loadDefaultImpls } from '../combine/index.mjs';
import { predictiveMask } from '../predict/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { leafBoxesOf, clientFrustumCull } from '../../../client/cull/index.mjs';

const CULL = /^Error: cull:/;
const isCullError = (e) => CULL.test(String(e)) && !(e instanceof TypeError);

const good = () => ({ width: 64, height: 48, K: { fx: 100, fy: 100, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const { cloud } = generate({ seed: 1, count: 2000 });
const healthy = () => buildHierarchy(cloud, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 64 });

function getFirstLeafNode(hierarchy) {
  const oc = hierarchy.octree;
  for (let i = 0; i < oc.nodeCount; i++) {
    if (oc.leafIndex[i] >= 0) return i;
  }
  return -1;
}

function getFirstInternalNode(hierarchy) {
  const oc = hierarchy.octree;
  for (let i = 0; i < oc.nodeCount; i++) {
    if (oc.leafIndex[i] < 0) return i;
  }
  return -1;
}

function withModifiedBox(hierarchy, nodeIndex, coordIndex, value) {
  const h = {
    ...hierarchy,
    octree: { ...hierarchy.octree },
    levels: hierarchy.levels,
  };
  h.octree.boxMin = new Float32Array(hierarchy.octree.boxMin);
  h.octree.boxMax = new Float32Array(hierarchy.octree.boxMax);

  if (Number.isNaN(value)) {
    h.octree.boxMin[3 * nodeIndex + coordIndex] = NaN;
  } else if (value === Infinity) {
    h.octree.boxMin[3 * nodeIndex + coordIndex] = Infinity;
  } else if (value === -Infinity) {
    h.octree.boxMax[3 * nodeIndex + coordIndex] = -Infinity;
  }
  return h;
}

const state = () => ({ camera: good(), velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] });
const PRED = { horizonS: 1, steps: 2, pointSizeM: 0.1 };

const baseH = healthy();
const okCones = leafNormalCones(baseH);
const okPyr = buildDepthPyramid(baseH, good());
const okMask = new Uint8Array(baseH.octree.leafCount).fill(1);

// frustumCull
test('frustumCull × Inf 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  const result = frustumCull(h, good());
  assert(result instanceof Uint8Array);
});

test('frustumCull × NaN 리프: pass', () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = frustumCull(h, good());
  assert(result instanceof Uint8Array);
});

test('frustumCull × NaN 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = frustumCull(h, good());
  assert(result instanceof Uint8Array);
});

// distanceCull
test('distanceCull × Inf 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  const result = distanceCull(h, good(), { maxDistanceM: 100 });
  assert(result instanceof Uint8Array);
});

test('distanceCull × NaN 리프: pass', () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = distanceCull(h, good(), { maxDistanceM: 100 });
  assert(result instanceof Uint8Array);
});

test('distanceCull × NaN 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = distanceCull(h, good(), { maxDistanceM: 100 });
  assert(result instanceof Uint8Array);
});

// leafNormalCones (used by backface)
test('leafNormalCones × Inf 내부 노드: throw cull:', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  assert.throws(() => leafNormalCones(h), isCullError);
});

test('leafNormalCones × NaN 리프: throw cull:', () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  assert.throws(() => leafNormalCones(h), isCullError);
});

test('leafNormalCones × NaN 내부 노드: throw cull:', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  assert.throws(() => leafNormalCones(h), isCullError);
});

// backfaceCull
test('backfaceCull × Inf 내부 노드: throw cull:', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  assert.throws(() => backfaceCull(h, good(), okCones), isCullError);
});

test('backfaceCull × NaN 리프: throw cull:', () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  assert.throws(() => backfaceCull(h, good(), okCones), isCullError);
});

test('backfaceCull × NaN 내부 노드: throw cull:', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  assert.throws(() => backfaceCull(h, good(), okCones), isCullError);
});

// occlusionCull
test('occlusionCull × Inf 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  const result = occlusionCull(h, good(), okPyr);
  assert(result instanceof Uint8Array);
});

test('occlusionCull × NaN 리프: pass (NaN 리프 = 빈 상자 = 남김)', () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = occlusionCull(h, good(), okPyr);
  assert(result instanceof Uint8Array);
});

test('occlusionCull × NaN 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = occlusionCull(h, good(), okPyr);
  assert(result instanceof Uint8Array);
});

// leafPriority
test('leafPriority × Inf 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  const result = leafPriority(h, good());
  assert(result instanceof Float64Array);
});

test('leafPriority × NaN 리프: pass', () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = leafPriority(h, good());
  assert(result instanceof Float64Array);
});

test('leafPriority × NaN 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = leafPriority(h, good());
  assert(result instanceof Float64Array);
});

// predictiveMask
test('predictiveMask × Inf 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  const result = predictiveMask(h, state(), PRED);
  assert(result instanceof Uint8Array);
});

test('predictiveMask × NaN 리프: pass', () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = predictiveMask(h, state(), PRED);
  assert(result instanceof Uint8Array);
});

test('predictiveMask × NaN 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = predictiveMask(h, state(), PRED);
  assert(result instanceof Uint8Array);
});

// orderChunks
test('orderChunks × Inf 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  const result = orderChunks(h, good(), okMask);
  assert(result instanceof Uint32Array);
});

test('orderChunks × NaN 리프: pass', () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = orderChunks(h, good(), okMask);
  assert(result instanceof Uint32Array);
});

test('orderChunks × NaN 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = orderChunks(h, good(), okMask);
  assert(result instanceof Uint32Array);
});

// leafBoxesOf
test('leafBoxesOf × Inf 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  const result = leafBoxesOf(h.octree);
  assert(result && result.boxMin instanceof Float32Array);
});

test('leafBoxesOf × NaN 리프: pass', () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = leafBoxesOf(h.octree);
  assert(result && result.boxMin instanceof Float32Array);
});

test('leafBoxesOf × NaN 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  const result = leafBoxesOf(h.octree);
  assert(result && result.boxMin instanceof Float32Array);
});

// clientFrustumCull
test('clientFrustumCull × Inf 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  const boxes = leafBoxesOf(h.octree);
  const result = clientFrustumCull(boxes, good());
  assert(result instanceof Uint8Array);
});

test('clientFrustumCull × NaN 리프: pass', () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  const boxes = leafBoxesOf(h.octree);
  const result = clientFrustumCull(boxes, good());
  assert(result instanceof Uint8Array);
});

test('clientFrustumCull × NaN 내부 노드: pass', () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  const boxes = leafBoxesOf(h.octree);
  const result = clientFrustumCull(boxes, good());
  assert(result instanceof Uint8Array);
});

// cullAndSelect (combine)
test('cullAndSelect × Inf 내부 노드: throw cull:', async () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, Infinity);
  const impls = await loadDefaultImpls();
  const opts = {
    thresholdPx: 1,
    stageImpls: impls.stageImpls,
    orderChunks: impls.orderChunks,
    isDegenerateView: impls.isDegenerateView,
  };
  assert.throws(() => cullAndSelect(h, good(), opts), isCullError);
});

test('cullAndSelect × NaN 리프: throw cull:', async () => {
  const node = getFirstLeafNode(baseH);
  const h = withModifiedBox(baseH, node, 0, NaN);
  const impls = await loadDefaultImpls();
  const opts = {
    thresholdPx: 1,
    stageImpls: impls.stageImpls,
    orderChunks: impls.orderChunks,
    isDegenerateView: impls.isDegenerateView,
  };
  assert.throws(() => cullAndSelect(h, good(), opts), isCullError);
});

test('cullAndSelect × NaN 내부 노드: throw cull:', async () => {
  const node = getFirstInternalNode(baseH);
  if (node < 0) return;
  const h = withModifiedBox(baseH, node, 0, NaN);
  const impls = await loadDefaultImpls();
  const opts = {
    thresholdPx: 1,
    stageImpls: impls.stageImpls,
    orderChunks: impls.orderChunks,
    isDegenerateView: impls.isDegenerateView,
  };
  assert.throws(() => cullAndSelect(h, good(), opts), isCullError);
});
