// 계층 조립(T07 통합). 팔진 트리·복셀 축소·법선·색 대표값을 이어 붙여 Hierarchy 를 만든다.
// 단계 0 은 원본 전부, 단계 l≥1 은 한 변 edge0M·2^l 격자 칸당 대표점 1개(입력 점의 부분집합, 새 점 없음).
// 대표점은 팔진 트리 리프 순서로 정렬해 리프마다 연속 구간을 이룬다.
import { assertCloud, assertLevelParams, edgeOfLevel } from '../../../contracts/lod/index.mjs';
import { buildOctree } from '../octree/index.mjs';
import { voxelReduce } from '../voxel/index.mjs';
import { representativeNormals } from '../normals/index.mjs';
import { representativeColors } from '../colors/index.mjs';

/** @returns {import('../../../contracts/lod/index.mjs').Hierarchy} */
export function buildHierarchy(cloud, opts = {}) {
  const n = assertCloud(cloud);
  const { edge0M, levelCount, maxLeafPoints = 4096, maxDepth = 12 } = opts;
  assertLevelParams(edge0M, levelCount);
  const octree = buildOctree(cloud, { maxLeafPoints, maxDepth });
  const leafOf = new Int32Array(n);
  for (let k = 0; k < octree.leafCount; k++) {
    for (let s = octree.leafStart[k]; s < octree.leafStart[k + 1]; s++) leafOf[octree.order[s]] = k;
  }
  const levels = [];
  for (let l = 0; l < levelCount; l++) {
    let rep, normals, colors;
    if (l === 0) {
      rep = Uint32Array.from(octree.order);
      normals = new Float32Array(3 * n);
      colors = new Uint8Array(3 * n);
      for (let s = 0; s < n; s++) {
        const i = rep[s];
        normals.set(cloud.normals.subarray(3 * i, 3 * i + 3), 3 * s);
        colors.set(cloud.colors.subarray(3 * i, 3 * i + 3), 3 * s);
      }
    } else {
      const vox = voxelReduce(cloud, edgeOfLevel(edge0M, l));
      const nrm = representativeNormals(cloud, vox);
      const col = representativeColors(cloud, vox);
      const ord = Array.from({ length: vox.count }, (_, c) => c).sort((a, b) => leafOf[vox.rep[a]] - leafOf[vox.rep[b]] || a - b);
      rep = new Uint32Array(vox.count);
      normals = new Float32Array(3 * vox.count);
      colors = new Uint8Array(3 * vox.count);
      ord.forEach((c, s) => {
        rep[s] = vox.rep[c];
        normals.set(nrm.subarray(3 * c, 3 * c + 3), 3 * s);
        colors.set(col.subarray(3 * c, 3 * c + 3), 3 * s);
      });
    }
    const leafStart = new Uint32Array(octree.leafCount + 1);
    for (let s = 0; s < rep.length; s++) leafStart[leafOf[rep[s]] + 1]++;
    for (let k = 0; k < octree.leafCount; k++) leafStart[k + 1] += leafStart[k];
    levels.push({ level: l, edgeM: edgeOfLevel(edge0M, l), count: rep.length, indices: rep, leafStart, normals, colors });
  }
  return { cloud, octree, edge0M, levels };
}
