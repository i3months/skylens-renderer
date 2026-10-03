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

test('F-153 leafIndex 가 Float32Array(1.5 포함)면 cull: 오류', () => {
  const li = Float32Array.from(h.octree.leafIndex);
  const k = li.findIndex((v) => v >= 0);
  li[k] = 1.5;
  const bad = { ...h, octree: { ...h.octree, leafIndex: li } };
  assert.throws(() => leafPriority(bad, cam), /^Error: cull:/);
  assert.throws(() => orderChunks(bad, cam, new Uint8Array(h.octree.leafCount).fill(1)), /^Error: cull:/);
});
