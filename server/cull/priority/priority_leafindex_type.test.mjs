// F-153: leafIndex 는 Int32Array 여야 한다(frustum 과 같은 규칙). 다른 타입배열은 'cull:' 오류.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { leafPriority, orderChunks } from './index.mjs';

const { cloud } = generate({ seed: 1, count: 500 });
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 64 });
const cam = viewpointToCamera({ eye: [0, 120, 140], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 });

test('양성 대조: 정상 leafIndex(Int32Array)는 통과', () => {
  assert.equal(leafPriority(h, cam).length, h.octree.leafCount);
  assert(orderChunks(h, cam, new Uint8Array(h.octree.leafCount).fill(1)) instanceof Uint32Array);
});

test('F-153 leafIndex 가 Float32Array(1.5 포함)면 cull: 오류', () => {
  const li = Float32Array.from(h.octree.leafIndex);
  const k = li.findIndex((v) => v >= 0);
  li[k] = 1.5;
  const bad = { ...h, octree: { ...h.octree, leafIndex: li } };
  assert.throws(() => leafPriority(bad, cam), /^Error: cull:/);
  assert.throws(() => orderChunks(bad, cam, new Uint8Array(h.octree.leafCount).fill(1)), /^Error: cull:/);
});

test('F-153 leafIndex 가 Float32Array(모두 정수)면 Int32Array 가 아니므로 cull: 오류', () => {
  const li = Float32Array.from(h.octree.leafIndex);
  const bad = { ...h, octree: { ...h.octree, leafIndex: li } };
  assert.throws(() => leafPriority(bad, cam), /^Error: cull:/);
  assert.throws(() => orderChunks(bad, cam, new Uint8Array(h.octree.leafCount).fill(1)), /^Error: cull:/);
});
