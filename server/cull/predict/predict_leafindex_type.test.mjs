// F-153: predict 의 octree 배열 형식 검사(leafIndex=Int32Array, boxMin/boxMax=Float32Array).
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

test('양성 대조: 정상 계층은 통과', () => {
  const h = mk();
  assert.equal(predictiveMask(h, state, opts).length, h.octree.leafCount);
});

test('Float32Array leafIndex(1.5 포함)는 cull: 오류', () => {
  const h = mk();
  const f = Float32Array.from(h.octree.leafIndex);
  f[h.octree.leafIndex.findIndex((k) => k >= 0)] = 1.5;
  h.octree.leafIndex = f;
  assert.throws(() => predictiveMask(h, state, opts), CULL);
});

test('일반 배열 leafIndex 와 일반 배열 상자는 cull: 오류', () => {
  let h = mk();
  h.octree.leafIndex = Array.from(h.octree.leafIndex);
  assert.throws(() => predictiveMask(h, state, opts), CULL);
  h = mk();
  h.octree.boxMin = Array.from(h.octree.boxMin);
  assert.throws(() => predictiveMask(h, state, opts), CULL);
  h = mk();
  h.octree.boxMax = Array.from(h.octree.boxMax);
  assert.throws(() => predictiveMask(h, state, opts), CULL);
});

test('F-153 leafIndex 가 Float32Array(모두 정수)면 Int32Array 가 아니므로 cull: 오류', () => {
  const h = mk();
  h.octree.leafIndex = Float32Array.from(h.octree.leafIndex);
  assert.throws(() => predictiveMask(h, state, opts), CULL);
});
