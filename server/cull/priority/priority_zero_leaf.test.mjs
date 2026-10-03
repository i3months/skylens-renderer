// F-145: leafCount < 1 계층은 contracts/cull 규칙대로 'cull:' 구조 오류를 던진다. 정상 계층은 영향 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { orderChunks, leafPriority } from './index.mjs';

const CAM = { width: 320, height: 180, K: { fx: 400, fy: 400, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const pos = [];
for (let i = 0; i < 20; i++) for (let j = 0; j < 12; j++) pos.push((i - 10) * 0.05, (j - 6) * 0.05, 1.5);
const n = pos.length / 3;
const cloud = { format: 1, count: n, positions: Float32Array.from(pos), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) };
const good = buildHierarchy(cloud, { edge0M: 0.05, levelCount: 2, maxLeafPoints: 16 });

// 리프 0 개 계층: 올바른 계층의 octree 를 leafCount 0 으로 바꾼다.
const zero = { ...good, octree: { ...good.octree, leafCount: 0, leafStart: new Uint32Array(1) } };

test('leafCount 0 계층: leafPriority·orderChunks 모두 cull: 로 던짐', () => {
  assert.throws(() => leafPriority(zero, CAM), /cull:/);
  assert.throws(() => orderChunks(zero, CAM, new Uint8Array(0)), /cull:/);
});

test('정상 계층: 던지지 않고 모든 리프를 정렬', () => {
  const L = good.octree.leafCount;
  assert.ok(L >= 1);
  assert.equal(leafPriority(good, CAM).length, L);
  assert.equal(orderChunks(good, CAM, new Uint8Array(L).fill(1)).length, L);
});
