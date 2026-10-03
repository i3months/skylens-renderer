// 가림 컬링 계층 검사(F-150 ②): 리프 노드 상자의 ±Infinity 와 leafIndex 중복·범위 밖은 'cull:' 오류, NaN 상자는 기존대로 통과.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { occlusionCull, buildDepthPyramid } from './index.mjs';

const CAM = Object.freeze({ width: 128, height: 128, K: { fx: 100, fy: 100, cx: 64, cy: 64 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

function scene() {
  const n = 2000, positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n).fill(128);
  for (let i = 0; i < n; i++) { positions.set([(i % 40) / 10 - 2, Math.floor(i / 40) / 10 - 2, 10 + (i % 7)], 3 * i); normals[3 * i + 2] = -1; }
  return buildHierarchy({ format: 1, count: n, positions, normals, colors }, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 200 });
}

const leafNode = (h) => h.octree.leafIndex.findIndex((k) => k >= 0);

test('리프 노드 상자의 ±Infinity 는 cull: 오류(최소·최대, 모든 축)', () => {
  for (const arr of ['boxMin', 'boxMax']) {
    for (const bad of [Infinity, -Infinity]) {
      for (let a = 0; a < 3; a++) {
        const h = scene();
        h.octree[arr][3 * leafNode(h) + a] = bad;
        assert.throws(() => occlusionCull(h, CAM), /^Error: cull:/, `${arr}[${a}]=${bad}`);
        assert.throws(() => buildDepthPyramid(h, CAM), /^Error: cull:/, `${arr}[${a}]=${bad}`);
      }
    }
  }
});

test('NaN 상자는 던지지 않는다(리프를 남기는 기존 정책)', () => {
  const h = scene();
  h.octree.boxMin[3 * leafNode(h)] = NaN;
  let m;
  assert.doesNotThrow(() => { m = occlusionCull(h, CAM); });
  assert.equal(m.length, h.octree.leafCount);
});

test('leafIndex 중복·범위 밖은 cull: 오류', () => {
  const dup = scene();
  const leaves = [];
  dup.octree.leafIndex.forEach((k, n) => { if (k >= 0) leaves.push(n); });
  assert.ok(leaves.length >= 2, '전제: 리프가 둘 이상');
  dup.octree.leafIndex[leaves[1]] = dup.octree.leafIndex[leaves[0]];
  assert.throws(() => occlusionCull(dup, CAM), /^Error: cull:/);
  assert.throws(() => buildDepthPyramid(dup, CAM), /^Error: cull:/);
  for (const bad of [dup.octree.leafCount, 1e9, -2]) {
    const h = scene();
    h.octree.leafIndex[leafNode(h)] = bad;
    assert.throws(() => occlusionCull(h, CAM), /^Error: cull:/, String(bad));
    assert.throws(() => buildDepthPyramid(h, CAM), /^Error: cull:/, String(bad));
  }
});

test('정상 계층은 그대로 통과', () => {
  assert.doesNotThrow(() => occlusionCull(scene(), CAM));
});
