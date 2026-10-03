// LOD 계약(T07). 원본 점군(format 1, 27 B 점)을 "줄이는" 쪽으로만 쓴다: 새 점을 만들지 않고 입력 점의 부분집합만 고른다.
// 도착하지 않은 점을 만들거나 빈자리를 메우지 않는다(skylens 원칙). 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m.
//
// 단계(level): 0 = 원본 전부. 단계 l 은 한 변 edgeM(l) = edge0M·2^l 인 격자 칸마다 대표점 1개만 남긴다.
//   칸당 한 점이므로 면 위 점 밀도는 단계마다 약 1/4 로 준다(4^-l).
// 거리 근거(renderer_basis §3-7 과 SPEC §3 의 Δd ≈ d²/(f·b) 를 화면 공간 오차로 옮긴 것):
//   카메라와 거리 d 에서 한 칸이 화면에서 차지하는 크기 = f·edgeM/d 픽셀. 허용 오차 thresholdPx(τ) 이하이면 그 단계로 충분하다.
//   단계 l 이 쓰이기 시작하는 거리(하한) maxDistanceM(l) = f·edgeM(l)/τ — 이름과 달리 '최대' 가 아니다.
//   단계 l 의 사용 구간은 [maxDistanceM(l), maxDistanceM(l+1)) 이고 마지막 단계는 그 위로 열려 있다. 거리 d 에는 f·edgeM(l)/d ≤ τ 를 만족하는 가장 큰 l 을 쓴다.
//   edge0M 은 원본 정밀도 하한: 깊이 해상도 Δd(d_c, b) = d_c²/(f·b) 보다 촘촘하게 둘 필요 없다(T07.3 이 표로 기록).
// 점 수 정의: 점 수는 positions.length/3 이고 cloud.count 와 같아야 한다(다르면 명시 오류).

/**
 * @typedef {import('../points/index.mjs').Point27Cloud} Point27Cloud
 *
 * @typedef {Object} VoxelResult  server/lod/voxel
 * @property {number} edgeM
 * @property {number} count          칸 수 = 대표점 수
 * @property {Uint32Array} rep       대표점의 입력 번호, 칸 키 오름차순, 길이 count. 입력 점의 부분집합.
 * @property {Uint32Array} cellOfPoint  길이 n. 각 입력 점이 속한 칸 번호(0..count-1)
 *
 * @typedef {Object} Octree  server/lod/octree  (첫 자식 순서 = 노드 번호 순서, 루트 = 0)
 * @property {number} nodeCount
 * @property {number} leafCount
 * @property {Int32Array} firstChild  리프이면 −1. 자식은 firstChild..firstChild+childCount−1 에 연속
 * @property {Uint8Array} childCount
 * @property {Int32Array} leafIndex   노드 → 리프 번호(0..leafCount−1), 내부 노드는 −1
 * @property {Float32Array} boxMin    3·nodeCount
 * @property {Float32Array} boxMax    3·nodeCount
 * @property {Uint32Array} leafStart  길이 leafCount+1. order[leafStart[k]..leafStart[k+1]) 이 리프 k 의 점
 * @property {Uint32Array} order      길이 n. 입력 점 번호를 리프 순서로 재배열(모든 점이 정확히 한 리프에)
 *
 * @typedef {Object} LodLevel
 * @property {number} level
 * @property {number} edgeM
 * @property {number} count
 * @property {Uint32Array} indices    입력 점 번호(부분집합). 리프 순서로 정렬
 * @property {Uint32Array} leafStart  길이 leafCount+1. indices[leafStart[k]..leafStart[k+1]) 이 리프 k 의 대표점
 * @property {Float32Array} normals   3·count 단위 길이(길이 0 입력은 (0,0,0) 유지)
 * @property {Uint8Array} colors      3·count 칸 안 점들의 평균색
 *
 * @typedef {Object} Hierarchy  server/lod/hierarchy 는 만들지 않는다: 각 하위 모듈의 함수를 buildHierarchy 가 이어 붙인다(T07.4 소유)
 * @property {Point27Cloud} cloud
 * @property {Octree} octree
 * @property {number} edge0M
 * @property {LodLevel[]} levels      levels[0] 은 원본 전부, 길이 levelCount
 *
 * @typedef {Object} Selection  server/lod/select, budget
 * @property {Uint8Array} leafLevel   길이 leafCount, 리프마다 고른 단계. 255 = 안 그림(시야 밖·예산 초과)
 * @property {number} pointCount      고른 점 수의 합
 *
 * @typedef {Object} ViewScoreEntry
 * @property {number} index  후보 번호
 * @property {number} score
 */

export const MAX_LEVELS = 12;
export const NOT_DRAWN = 255;
/** renderer_basis §3-3, §3-4 의 예시 상수 */
export const VIEW_SCORE_CONSTANTS = Object.freeze({ theta0Deg: 10, sigmaSmallDeg: 4, sigmaLargeDeg: 15, scaleBand: 1.2 });

/** 함수 서명. 이름과 모듈 위치는 이 표가 기준이다. */
export const LOD_API = Object.freeze({
  voxel: { module: 'server/lod/voxel/index.mjs', fn: 'voxelReduce(cloud, edgeM) -> VoxelResult   대표점 = 칸 안에서 칸 중심에 가장 가까운 입력 점(동률이면 번호 작은 점)' },
  octree: { module: 'server/lod/octree/index.mjs', fn: 'buildOctree(cloud, {maxLeafPoints=4096, maxDepth=12}) -> Octree' },
  distance_table: { module: 'server/lod/distance_table/index.mjs', fn: 'buildDistanceTable({fx, thresholdPx, edge0M, levelCount}) -> {levels:[{level, edgeM, maxDistanceM(단계 l 이 쓰이기 시작하는 거리, 하한)}]} ; levelForDistance(table, d) -> level ; depthResolutionM(d, fx, baselineM) -> number' },
  normals: { module: 'server/lod/normals/index.mjs', fn: 'representativeNormals(cloud, voxel) -> Float32Array(3·count)   칸 안 법선 합의 정규화, 합이 0 이면 (0,0,0)' },
  colors: { module: 'server/lod/colors/index.mjs', fn: 'representativeColors(cloud, voxel) -> Uint8Array(3·count)   칸 안 평균색(반올림)' },
  select: { module: 'server/lod/select/index.mjs', fn: 'buildHierarchy(cloud, {edge0M, levelCount, maxLeafPoints}) -> Hierarchy ; selectLevels(hierarchy, camera, {thresholdPx}) -> Selection ; materialize(hierarchy, selection) -> Point27Cloud' },
  budget: { module: 'server/lod/budget/index.mjs', fn: 'selectWithBudget(hierarchy, camera, {budgetPoints, thresholdPx}) -> Selection   pointCount ≤ budgetPoints' },
  view_score: { module: 'server/lod/view_score/index.mjs', fn: 'angleScore(thetaDeg) -> number ; scaleScore(s) -> number ; viewScore(refCam, candCam, points) -> number ; rankViews(refCam, candCams, points) -> ViewScoreEntry[] 점수 내림차순' },
  progressive: { module: 'server/lod/progressive/index.mjs', fn: 'progressiveChunks(hierarchy, camera, {thresholdPx}) -> {level, leaf, indices:Uint32Array}[]   거친 단계 먼저, 한 리프는 목표 단계 한 번만(교체이지 누적이 아님)' },
  no_fill: { module: 'server/lod/no_fill/index.mjs', fn: 'emptyRatioPreserved(cloud, selectedCloud, camera, opts?) -> {original, lod, equal, filled, noFill}   빈 픽셀 비율, 원본에서 빈데 LOD 에서 칠해진 픽셀 수(filled)와 filled===0 여부(noFill)(참조 래스터라이저)' },
  bench: { module: 'bench/lod/index.mjs', fn: 'measureSegmentBytes(cloud, opts) -> {points, bytesByLevel}' },
});

const ERR = 'lod:';

/** 점군이 계약대로인지 검사한다. 틀리면 'lod:' 로 시작하는 Error. */
export function assertCloud(cloud) {
  if (!cloud || typeof cloud !== 'object') throw new Error(`${ERR} 점군이 객체가 아님`);
  if (cloud.format !== 1) throw new Error(`${ERR} format 1(27 B 점)만 받음: ${String(cloud.format)}`);
  const { positions, normals, colors, count } = cloud;
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) throw new Error(`${ERR} positions 는 3의 배수 길이 Float32Array`);
  const n = positions.length / 3;
  if (!Number.isInteger(count) || count !== n) throw new Error(`${ERR} count(${String(count)}) 와 positions.length/3(${n}) 불일치`);
  if (!(normals instanceof Float32Array) || normals.length !== 3 * n) throw new Error(`${ERR} normals 길이가 3·n 이 아님`);
  if (!(colors instanceof Uint8Array) || colors.length !== 3 * n) throw new Error(`${ERR} colors 길이가 3·n 이 아님`);
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new Error(`${ERR} positions[${i}] 가 유한하지 않음`);
  return n;
}

/** 단계 수와 한 변 길이 검사. */
export function assertLevelParams(edge0M, levelCount) {
  if (!(typeof edge0M === 'number' && Number.isFinite(edge0M) && edge0M > 0)) throw new Error(`${ERR} edge0M 은 양의 유한수: ${String(edge0M)}`);
  if (!Number.isInteger(levelCount) || levelCount < 1 || levelCount > MAX_LEVELS) throw new Error(`${ERR} levelCount 는 1..${MAX_LEVELS} 정수: ${String(levelCount)}`);
}

/** 단계 l 의 칸 한 변(m). */
export const edgeOfLevel = (edge0M, level) => edge0M * 2 ** level;
