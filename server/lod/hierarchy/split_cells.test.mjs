// splitCellsByLeaf 합성 키 정렬이 옛 비교 함수 정렬과 같은 칸 구성·순서를 내는지 무작위 입력으로 비교한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from './index.mjs';
import { buildOctree } from '../octree/index.mjs';
import { voxelReduce } from '../voxel/index.mjs';
import { edgeOfLevel } from '../../../contracts/lod/index.mjs';

// 옛 구현(비교 함수 정렬) 그대로.
function oldSplitCellsByLeaf(pos, vox, octree) {
  const n = vox.cellOfPoint.length, edge = vox.edgeM, cellOf = vox.cellOfPoint;
  const cellOfPoint = new Uint32Array(n);
  const repList = [], leafOfPiece = [];
  const seg = new Uint32Array(n);
  for (let k = 0; k < octree.leafCount; k++) {
    const s0 = octree.leafStart[k], s1 = octree.leafStart[k + 1];
    const m = s1 - s0;
    const part = seg.subarray(0, m);
    part.set(octree.order.subarray(s0, s1));
    part.sort((a, b) => cellOf[a] - cellOf[b] || a - b);
    let best = -1, bestD = Infinity;
    for (let q = 0; q < m; q++) {
      const i = part[q];
      if (q === 0 || cellOf[i] !== cellOf[part[q - 1]]) {
        if (best >= 0) { repList.push(best); leafOfPiece.push(k); }
        best = -1; bestD = Infinity;
      }
      cellOfPoint[i] = repList.length;
      let d2 = 0;
      for (let d = 0; d < 3; d++) {
        const v = pos[3 * i + d];
        const t = v - (Math.floor(v / edge) + 0.5) * edge;
        d2 += t * t;
      }
      if (d2 < bestD) { bestD = d2; best = i; } // 번호 오름차순으로 훑으므로 동률은 번호 작은 점
    }
    if (best >= 0) { repList.push(best); leafOfPiece.push(k); }
  }
  return { edgeM: edge, count: repList.length, rep: Uint32Array.from(repList), cellOfPoint, leafOfPiece };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function randomCloud(n, seed, spread) {
  const r = rng(seed);
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
  for (let i = 0; i < 3 * n; i++) {
    // 일부는 격자에 겹치도록 거칠게 양자화해 동률(같은 칸·같은 거리)을 만든다.
    const v = (r() - 0.5) * spread;
    positions[i] = seed % 2 ? Math.round(v * 4) / 4 : v;
    normals[i] = r() - 0.5; colors[i] = (r() * 256) | 0;
  }
  return { format: 1, count: n, positions, normals, colors };
}

for (const [n, seed, spread, edge0M, maxLeafPoints] of [
  [1, 1, 10, 0.5, 8], [500, 2, 20, 0.5, 16], [3000, 3, 30, 0.7, 64], [4000, 4, 5, 0.25, 32], [6000, 7, 100, 1, 50],
]) {
  test(`splitCellsByLeaf 동등성: n=${n} seed=${seed}`, () => {
    const cloud = randomCloud(n, seed, spread);
    const levelCount = 4;
    const h = buildHierarchy(cloud, { edge0M, levelCount, maxLeafPoints });
    const octree = buildOctree(cloud, { maxLeafPoints, maxDepth: 12 });
    for (let l = 1; l < levelCount; l++) {
      const ref = oldSplitCellsByLeaf(cloud.positions, voxelReduce(cloud, edgeOfLevel(edge0M, l)), octree);
      const lv = h.levels[l];
      assert.equal(lv.count, ref.count);
      assert.deepEqual(Array.from(lv.indices), Array.from(ref.rep));
      const leafStart = new Uint32Array(octree.leafCount + 1);
      for (let c = 0; c < ref.count; c++) leafStart[ref.leafOfPiece[c] + 1]++;
      for (let k = 0; k < octree.leafCount; k++) leafStart[k + 1] += leafStart[k];
      assert.deepEqual(Array.from(lv.leafStart), Array.from(leafStart));
    }
  });
}
