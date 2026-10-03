// F-145: 리프 0 개 계층에서 모든 컬링 단계가 'cull:' 오류를 던진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { frustumCull } from '../frustum/index.mjs';
import { distanceCull } from '../distance/index.mjs';
import { leafNormalCones, backfaceCull } from '../backface/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../occlusion/index.mjs';
import { leafPriority, orderChunks } from '../priority/index.mjs';
import { cullAndSelect, loadDefaultImpls } from '../combine/index.mjs';
import { leafBoxesOf } from '../../../client/cull/index.mjs';

const CULL = /^Error: cull:/;

const good = () => ({ width: 64, height: 48, K: { fx: 100, fy: 100, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

// 리프 0 개, 노드 1 개 최소 계층
const zeroLeafHierarchy = () => ({
  octree: {
    nodeCount: 1,
    leafCount: 0,
    leafIndex: Int32Array.from([-1]),
    boxMin: new Float32Array(3),
    boxMax: new Float32Array(3),
  },
  levels: [{
    leafStart: new Uint32Array([0]),
    positions: new Float32Array(0),
    normals: new Float32Array(0),
  }],
});

test('리프 0 개 계층: frustumCull 은 cull: 오류', () => {
  const h = zeroLeafHierarchy();
  assert.throws(() => frustumCull(h, good()), CULL);
});

test('리프 0 개 계층: distanceCull 은 cull: 오류', () => {
  const h = zeroLeafHierarchy();
  assert.throws(() => distanceCull(h, good(), { maxDistanceM: 100 }), CULL);
});

test('리프 0 개 계층: leafNormalCones 는 cull: 오류', () => {
  const h = zeroLeafHierarchy();
  assert.throws(() => leafNormalCones(h), CULL);
});

test('리프 0 개 계층: backfaceCull 는 cull: 오류 (leafNormalCones 단계)', () => {
  const h = zeroLeafHierarchy();
  assert.throws(() => {
    const cones = leafNormalCones(h);
    backfaceCull(h, good(), cones);
  }, CULL);
});

test('리프 0 개 계층: buildDepthPyramid 는 cull: 오류', () => {
  const h = zeroLeafHierarchy();
  assert.throws(() => buildDepthPyramid(h, good()), CULL);
});

test('리프 0 개 계층: occlusionCull 는 cull: 오류 (buildDepthPyramid 단계)', () => {
  const h = zeroLeafHierarchy();
  assert.throws(() => {
    const pyr = buildDepthPyramid(h, good());
    occlusionCull(h, good(), pyr);
  }, CULL);
});

test('리프 0 개 계층: leafPriority 는 cull: 오류', () => {
  const h = zeroLeafHierarchy();
  assert.throws(() => leafPriority(h, good()), CULL);
});

test('리프 0 개 계층: orderChunks 는 cull: 오류', () => {
  const h = zeroLeafHierarchy();
  const mask = new Uint8Array(0);
  assert.throws(() => orderChunks(h, good(), mask), CULL);
});

test('리프 0 개 계층: 클라이언트 leafBoxesOf 는 cull: 오류', () => {
  assert.throws(() => leafBoxesOf(zeroLeafHierarchy().octree), CULL);
});

test('리프 0 개 계층: cullAndSelect 는 cull: 오류', async () => {
  const h = zeroLeafHierarchy();
  const d = await loadDefaultImpls();
  assert.throws(() => cullAndSelect(h, good(), {
    thresholdPx: 1,
    stageImpls: d.stageImpls,
    orderChunks: d.orderChunks,
    isDegenerateView: d.isDegenerateView,
  }), CULL);
});
