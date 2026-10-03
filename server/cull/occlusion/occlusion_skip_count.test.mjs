// 가림막 점 수(F-152 ⑨): 유한하지 않아 건너뛴 점은 occluderPoints 와 maxOccluderPoints 상한에 세지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { buildDepthPyramid } from './index.mjs';

const CAM = Object.freeze({ width: 128, height: 128, K: { fx: 100, fy: 100, cx: 64, cy: 64 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

// 점이 든 리프 하나뿐인 장면. 일부 점의 좌표를 비유한 값으로 바꾼다.
function scene() {
  const n = 100, positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n).fill(128);
  for (let i = 0; i < n; i++) { positions.set([(i % 10) / 20 - 0.25, Math.floor(i / 10) / 20 - 0.25, 2], 3 * i); normals[3 * i + 2] = -1; }
  return buildHierarchy({ format: 1, count: n, positions, normals, colors }, { edge0M: 4, levelCount: 1, maxLeafPoints: 1000 });
}

function poison(h, count) {
  const pos = h.levels[0].positions;
  const bad = [NaN, Infinity, -Infinity];
  for (let q = 0; q < count; q++) pos[3 * q + (q % 3)] = bad[q % 3];
  return h;
}

const OPTS = { size: 16, pointSizeM: 0.3 };

test('건너뛴 비유한 점은 occluderPoints 에 세지 않는다', () => {
  const clean = scene();
  assert.equal(clean.octree.leafCount, 1, '전제: 리프 하나');
  assert.equal(buildDepthPyramid(clean, CAM, OPTS).occluderPoints, 100, '전제: 점 100 개 모두 사용');
  assert.equal(buildDepthPyramid(poison(scene(), 7), CAM, OPTS).occluderPoints, 93);
});

test('상한은 실제로 쓰는 점 수로 비교한다', () => {
  const h = poison(scene(), 7);
  // 상한 93 = 쓰는 점 수: 리프가 들어간다(전체 점 수 100 으로 세면 건너뛰어 0).
  assert.equal(buildDepthPyramid(h, CAM, { ...OPTS, maxOccluderPoints: 93 }).occluderPoints, 93);
  // 상한 92: 쓰는 점 93 개가 넘으므로 건너뛴다.
  assert.equal(buildDepthPyramid(h, CAM, { ...OPTS, maxOccluderPoints: 92 }).occluderPoints, 0);
});

test('리프 점이 모두 비유한이면 0 개', () => {
  assert.equal(buildDepthPyramid(poison(scene(), 100), CAM, OPTS).occluderPoints, 0);
});
