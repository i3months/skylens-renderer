// T07.4 화면 공간 오차 기반 단계 선택. 계약: contracts/lod/index.mjs 의 "거리 근거", Selection, LOD_API.select.
//
// selectLevels: 팔진 트리 리프마다
//   1) 리프 상자가 카메라 시야 사각뿔 밖이면(8 꼭짓점이 모두 한 평면의 바깥: 앞(z>0)·좌·우·위·아래) NOT_DRAWN.
//      각 평면은 카메라 좌표에서 선형 반공간이므로 "꼭짓점 전부가 같은 평면 밖" 이면 상자 전체가 밖이다(보수적 판정:
//      여러 평면에 걸쳐 밖인 모서리 상자는 그림으로 남을 수 있으나, 보여야 할 리프를 버리는 일은 없다).
//   2) 아니면 상자와 카메라 중심의 최소 거리 d 로 distance_table 규칙(f = camera.K.fx) 에 따라 단계를 고른다:
//      f·edgeM(l)/d ≤ τ 인 가장 큰 l, 최대 단계는 levelCount−1. 카메라가 상자 안(d = 0)이면 원본 단계 0.
//      최소 거리를 쓰므로 리프 안 어느 점도 그 칸이 화면에서 τ 픽셀을 넘지 않는다(가장 가까운 점 기준의 보수적 선택).
// materialize: 선택된 단계의 대표점만 모은다. 위치 = 입력 점 위치 그대로, 법선·색 = 그 단계의 대표값. 새 점을 만들지 않는다.
//
// 알려진 한계(기록): 단계 l 의 칸은 전역 격자이고 대표점이 속한 리프에 배정된다. 칸이 리프 경계를 걸치고 두 리프의 단계가
//   다르면, 경계 근처에서 점이 조금 빠지거나 겹칠 수 있다(그 폭은 칸 한 변 이하, 즉 화면에서 τ 픽셀 이하).
import { NOT_DRAWN, assertCloud } from '../../../contracts/lod/index.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { buildDistanceTable, levelForDistance } from '../distance_table/index.mjs';

export { buildHierarchy } from '../hierarchy/index.mjs';

const ERR = 'lod:';

/** 계층이 계약대로인지 최소한으로 검사한다(구조·길이). */
function assertHierarchy(h) {
  if (!h || typeof h !== 'object') throw new Error(`${ERR} 계층이 객체가 아님`);
  const { octree, levels } = h;
  assertCloud(h.cloud);
  if (!octree || typeof octree !== 'object' || !Number.isInteger(octree.leafCount) || octree.leafCount < 1) throw new Error(`${ERR} 계층의 팔진 트리가 올바르지 않음`);
  if (!(octree.boxMin instanceof Float32Array) || !(octree.boxMax instanceof Float32Array) || !(octree.leafIndex instanceof Int32Array)) throw new Error(`${ERR} 팔진 트리 상자·리프 번호 배열이 없음`);
  if (!Array.isArray(levels) || levels.length < 1) throw new Error(`${ERR} 계층의 단계 배열이 비었음`);
  for (const lv of levels) {
    if (!lv || !(lv.indices instanceof Uint32Array) || !(lv.leafStart instanceof Uint32Array) || lv.leafStart.length !== octree.leafCount + 1) {
      throw new Error(`${ERR} 단계 ${String(lv?.level)} 의 구간 배열이 올바르지 않음`);
    }
  }
}

/** 카메라 검사 오류를 'lod:' 오류로 옮긴다. */
function checkCamera(camera) {
  try {
    assertCamera(camera);
  } catch (e) {
    throw new Error(`${ERR} 카메라가 올바르지 않음 (${e.message})`);
  }
}

/**
 * 리프 상자가 시야 사각뿔 밖인지. 카메라 좌표 X_c = R·X_w + t 에서 시야는
 *   z > 0,  fx·x + cx·z ≥ 0,  fx·x + (cx − W)·z ≤ 0,  fy·y + cy·z ≥ 0,  fy·y + (cy − H)·z ≤ 0
 * 의 교집합이다(u = fx·x/z + cx ∈ [0, W], v ∈ [0, H]). 8 꼭짓점이 모두 한 반공간 밖이면 밖.
 */
function outsideFrustum(camera, mn, mx) {
  const { R, t, K, width: W, height: H } = camera;
  const { fx, fy, cx, cy } = K;
  let allBehind = true, allLeft = true, allRight = true, allTop = true, allBottom = true;
  for (let c = 0; c < 8; c++) {
    const X = c & 1 ? mx[0] : mn[0];
    const Y = c & 2 ? mx[1] : mn[1];
    const Z = c & 4 ? mx[2] : mn[2];
    const x = R[0] * X + R[1] * Y + R[2] * Z + t[0];
    const y = R[3] * X + R[4] * Y + R[5] * Z + t[1];
    const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
    if (z > 0) allBehind = false;
    if (fx * x + cx * z >= 0) allLeft = false;
    if (fx * x + (cx - W) * z <= 0) allRight = false;
    if (fy * y + cy * z >= 0) allTop = false;
    if (fy * y + (cy - H) * z <= 0) allBottom = false;
  }
  return allBehind || allLeft || allRight || allTop || allBottom;
}

/** 카메라 중심 C = −Rᵀ·t 와 축 정렬 상자의 최소 거리(안에 있으면 0). */
function boxDistance(C, mn, mx) {
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const g = C[a] < mn[a] ? mn[a] - C[a] : C[a] > mx[a] ? C[a] - mx[a] : 0;
    s += g * g;
  }
  return Math.sqrt(s);
}

/**
 * 리프마다 단계를 고른다.
 * @param {import('../../../contracts/lod/index.mjs').Hierarchy} hierarchy
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {{thresholdPx:number}} opts thresholdPx = 허용 화면 오차 τ(px)
 * @returns {import('../../../contracts/lod/index.mjs').Selection}
 */
export function selectLevels(hierarchy, camera, opts) {
  assertHierarchy(hierarchy);
  checkCamera(camera);
  const thresholdPx = opts?.thresholdPx;
  if (!(typeof thresholdPx === 'number' && Number.isFinite(thresholdPx) && thresholdPx > 0)) throw new Error(`${ERR} thresholdPx 는 양의 유한수: ${String(thresholdPx)}`);
  const { octree, levels, edge0M } = hierarchy;
  const table = buildDistanceTable({ fx: camera.K.fx, thresholdPx, edge0M, levelCount: levels.length });
  const { R, t } = camera;
  const C = [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
  const leafLevel = new Uint8Array(octree.leafCount).fill(NOT_DRAWN);
  let pointCount = 0;
  const mn = [0, 0, 0], mx = [0, 0, 0];
  for (let node = 0; node < octree.nodeCount; node++) {
    const k = octree.leafIndex[node];
    if (k < 0) continue;
    for (let a = 0; a < 3; a++) { mn[a] = octree.boxMin[3 * node + a]; mx[a] = octree.boxMax[3 * node + a]; }
    if (outsideFrustum(camera, mn, mx)) continue;
    const d = boxDistance(C, mn, mx);
    const l = d > 0 ? levelForDistance(table, d) : 0;
    leafLevel[k] = l;
    pointCount += levels[l].leafStart[k + 1] - levels[l].leafStart[k];
  }
  return { leafLevel, pointCount };
}

/**
 * 선택된 단계의 대표점으로 점군을 만든다(format 1, count = selection.pointCount). 새 점 없음.
 * @returns {import('../../../contracts/lod/index.mjs').Point27Cloud}
 */
export function materialize(hierarchy, selection) {
  assertHierarchy(hierarchy);
  const { octree, levels, cloud } = hierarchy;
  if (!selection || !(selection.leafLevel instanceof Uint8Array) || selection.leafLevel.length !== octree.leafCount) {
    throw new Error(`${ERR} selection.leafLevel 은 길이 leafCount(${octree.leafCount}) 인 Uint8Array`);
  }
  const { leafLevel } = selection;
  let n = 0;
  for (let k = 0; k < octree.leafCount; k++) {
    const l = leafLevel[k];
    if (l === NOT_DRAWN) continue;
    if (l >= levels.length) throw new Error(`${ERR} 리프 ${k} 의 단계 ${l} 가 단계 수 ${levels.length} 를 넘음`);
    n += levels[l].leafStart[k + 1] - levels[l].leafStart[k];
  }
  if (selection.pointCount !== n) throw new Error(`${ERR} selection.pointCount(${String(selection.pointCount)}) 와 실제 점 수(${n}) 불일치`);
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  const src = cloud.positions;
  let o = 0;
  for (let k = 0; k < octree.leafCount; k++) {
    const l = leafLevel[k];
    if (l === NOT_DRAWN) continue;
    const lv = levels[l];
    const s0 = lv.leafStart[k], s1 = lv.leafStart[k + 1], idx = lv.indices;
    if (s1 === s0) continue;
    // 법선·색은 리프 구간이 연속이라 한 번에 복사, 위치만 색인 산술로 모은다.
    normals.set(lv.normals.subarray(3 * s0, 3 * s1), 3 * o);
    colors.set(lv.colors.subarray(3 * s0, 3 * s1), 3 * o);
    for (let s = s0, d = 3 * o; s < s1; s++, d += 3) {
      const b = 3 * idx[s];
      positions[d] = src[b]; positions[d + 1] = src[b + 1]; positions[d + 2] = src[b + 2];
    }
    o += s1 - s0;
  }
  return { format: 1, count: n, positions, normals, colors };
}
