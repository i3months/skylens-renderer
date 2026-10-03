// 계층 조립(T07 통합). 팔진 트리·복셀 축소·법선·색 대표값을 이어 붙여 Hierarchy 를 만든다.
// 단계 0 은 원본 전부(법선은 단위 길이로 정규화). 단계 l≥1 은 "리프 × 격자 칸" 조각마다 대표점 1개
// (격자 = 한 변 edge0M·2^l, floor(x/edge); 입력 점의 부분집합, 새 점 없음).
// 칸 키를 (leafOf, floor(x/edge)) 로 둔다(F-097 ②): 전역 격자 칸이 팔진 리프 경계를 걸치면 리프마다 따로 대표점을 둔다.
//   그래서 한 대표점이 대표하는 점들은 모두 같은 리프에 있고, 이웃 리프가 다른 단계를 골라도 어느 리프 조각도 대표점 없이 비지 않는다.
//   대가: 경계를 걸친 칸은 단계 l 에서 조각 수만큼 점이 남는다(그 단계의 점 수가 순수 격자 칸 수보다 약간 많다).
// 대표점 = 조각 안에서 격자 칸 중심 (k+0.5)·edge 에 가장 가까운 점(동률이면 번호 작은 점) — voxelReduce 와 같은 규칙.
// 법선·색은 조각 안 점들로 구한다(representativeNormals·representativeColors 에 조각을 칸으로 넘긴다).
// 대표점은 팔진 트리 리프 순서로 정렬해 리프마다 연속 구간을 이룬다. 리프 안에서는 격자 칸 번호(칸 키 사전순) 오름차순.
import { assertCloud, assertLevelParams, edgeOfLevel } from '../../../contracts/lod/index.mjs';
import { buildOctree } from '../octree/index.mjs';
import { voxelReduce } from '../voxel/index.mjs';
import { representativeNormals } from '../normals/index.mjs';
import { representativeColors } from '../colors/index.mjs';

/**
 * 격자 칸을 리프 경계로 쪼갠 VoxelResult 모양 객체. 조각 번호는 (리프, 격자 칸 번호) 오름차순.
 * @param {Float32Array} pos
 * @param {import('../../../contracts/lod/index.mjs').VoxelResult} vox
 * @param {import('../../../contracts/lod/index.mjs').Octree} octree
 */
function splitCellsByLeaf(pos, vox, octree) {
  const n = vox.cellOfPoint.length, edge = vox.edgeM, cellOf = vox.cellOfPoint;
  const cellOfPoint = new Uint32Array(n);
  const repList = [], leafOfPiece = [];
  const seg = new Uint32Array(n);
  let cellMax = 0;
  for (let i = 0; i < n; i++) if (cellOf[i] > cellMax) cellMax = cellOf[i];
  const useKey = (cellMax + 1) * n <= Number.MAX_SAFE_INTEGER;
  const keys = useKey ? new Float64Array(n) : null;
  for (let k = 0; k < octree.leafCount; k++) {
    const s0 = octree.leafStart[k], s1 = octree.leafStart[k + 1];
    const m = s1 - s0;
    const part = seg.subarray(0, m);
    if (useKey) {
      // 합성 키 cell·n + 점 번호 (< 2^53 이라 정확) 를 비교 함수 없이 숫자 정렬한다. 순서는 (칸, 번호) 사전순과 같다.
      const kp = keys.subarray(0, m);
      for (let q = 0; q < m; q++) { const i = octree.order[s0 + q]; kp[q] = cellOf[i] * n + i; }
      kp.sort();
      for (let q = 0; q < m; q++) part[q] = kp[q] % n;
    } else {
      part.set(octree.order.subarray(s0, s1));
      part.sort((a, b) => cellOf[a] - cellOf[b] || a - b);
    }
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

/** 단계 0 법선: 각 원본 법선을 단위 길이로. 길이 0·비유한은 (0,0,0)(계약의 "길이 0 입력은 (0,0,0) 유지"). */
function unitNormal(src, i, out, s) {
  const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2];
  const len = Math.hypot(x, y, z);
  if (!(len > 0) || !Number.isFinite(len)) return; // out 은 0 으로 초기화돼 있다
  out[3 * s] = x / len; out[3 * s + 1] = y / len; out[3 * s + 2] = z / len;
}

/** @returns {import('../../../contracts/lod/index.mjs').Hierarchy} */
export function buildHierarchy(cloud, opts = {}) {
  const n = assertCloud(cloud);
  const { edge0M, levelCount, maxLeafPoints = 4096, maxDepth = 12 } = opts;
  assertLevelParams(edge0M, levelCount);
  const octree = buildOctree(cloud, { maxLeafPoints, maxDepth });
  const levels = [];
  for (let l = 0; l < levelCount; l++) {
    let rep, normals, colors;
    const leafStart = new Uint32Array(octree.leafCount + 1);
    if (l === 0) {
      rep = Uint32Array.from(octree.order);
      normals = new Float32Array(3 * n);
      colors = new Uint8Array(3 * n);
      for (let s = 0; s < n; s++) {
        const i = rep[s];
        unitNormal(cloud.normals, i, normals, s);
        colors.set(cloud.colors.subarray(3 * i, 3 * i + 3), 3 * s);
      }
      leafStart.set(octree.leafStart);
    } else {
      const pieces = splitCellsByLeaf(cloud.positions, voxelReduce(cloud, edgeOfLevel(edge0M, l)), octree);
      rep = pieces.rep;
      normals = representativeNormals(cloud, pieces);
      colors = representativeColors(cloud, pieces);
      for (let c = 0; c < pieces.count; c++) leafStart[pieces.leafOfPiece[c] + 1]++;
      for (let k = 0; k < octree.leafCount; k++) leafStart[k + 1] += leafStart[k];
    }
    levels.push({ level: l, edgeM: edgeOfLevel(edge0M, l), count: rep.length, indices: rep, leafStart, normals, colors });
  }
  return { cloud, octree, edge0M, levels };
}
