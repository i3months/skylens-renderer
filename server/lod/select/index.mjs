// T07.4 화면 공간 오차 기반 단계 선택. 계약: contracts/lod/index.mjs 의 "거리 근거", Selection, LOD_API.select.
//
// selectLevels: 팔진 트리 리프마다
//   0) 점이 하나도 없는 리프(단계 0 구간이 빔)는 그릴 것이 없으므로 NOT_DRAWN(F-104 ④: budget·progressive 와 같은 규칙).
//   1) 리프 상자가 카메라 시야 사각뿔 밖이면(8 꼭짓점이 모두 한 평면의 바깥: 앞(z>0)·좌·우·위·아래; ./view_check.mjs 공용) NOT_DRAWN.
//      각 평면은 카메라 좌표에서 선형 반공간이므로 "꼭짓점 전부가 같은 평면 밖" 이면 상자 전체가 밖이다(보수적 판정:
//      여러 평면에 걸쳐 밖인 모서리 상자는 그림으로 남을 수 있으나, 보여야 할 리프를 버리는 일은 없다).
//   2) 아니면 ./screen_error.mjs 의 공용 규칙으로 단계를 고른다(budget·progressive 와 같은 규칙):
//      f = max(fx, fy), d = 상자와 카메라 중심의 최소 거리, cMin = 상자 꼭짓점의 cos(광축 각) 최솟값,
//      d_eff = max(d·cMin², z_P·c_P)(screen_error.mjs 참조) 에 대해 f·edgeM(l)/d_eff ≤ τ 인 가장 큰 l, 최대 단계는 levelCount−1.
//      카메라가 상자 안(d = 0)이거나 상자가 카메라 평면에 걸치면(cMin ≤ 0) 원본 단계 0.
//      축 밖 각 α 에서 투영 크기는 f·e/(r·cos²α) 이므로(F-097 ①), 리프 상자 안에 놓인 칸 변은 화면에서 τ 픽셀을 넘지 않는다.
// materialize: 선택된 단계의 대표점만 모은다. 위치 = 입력 점 위치 그대로, 법선·색 = 그 단계의 대표값. 새 점을 만들지 않는다.
//   위치는 build 때 리프 순서로 미리 담아 둔 levels[l].positions(입력 위치의 사본)를 법선·색처럼 리프 구간째 복사한다(F-099 ③).
//   이전에는 indices 로 cloud.positions 를 점마다 무작위 접근(gather)했고 이것이 지배 비용이었다. 대가: 대표점당 12 B 메모리.
//
// 칸은 (리프, 전역 격자 칸) 조각이라(F-097 ②, hierarchy) 리프 경계를 걸치는 칸이 없다.
import { NOT_DRAWN, assertCloud } from '../../../contracts/lod/index.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { screenErrorRule } from './screen_error.mjs';
import { boxMayBeVisible } from './view_check.mjs';

export { buildHierarchy } from '../hierarchy/index.mjs';

const ERR = 'lod:';

/**
 * 계층 입력 검사(구조·길이·타입). select·budget·progressive 가 공용으로 쓴다(F-107 ①). 오류는 모두 'lod:' 로 시작.
 * nodeCount·leafIndex(=nodeCount)·boxMin/boxMax(=3·nodeCount), 단계별 indices·leafStart·positions·normals·colors.
 */
export function assertHierarchyInput(h) {
  if (!h || typeof h !== 'object') throw new Error(`${ERR} 계층이 객체가 아님`);
  const { octree, levels } = h;
  assertCloud(h.cloud);
  if (!octree || typeof octree !== 'object' || !Number.isInteger(octree.leafCount) || octree.leafCount < 1) throw new Error(`${ERR} 계층의 팔진 트리가 올바르지 않음`);
  const nc = octree.nodeCount;
  if (!Number.isInteger(nc) || nc < octree.leafCount) throw new Error(`${ERR} octree.nodeCount 는 leafCount 이상의 정수: ${String(nc)}`);
  if (!(octree.boxMin instanceof Float32Array) || !(octree.boxMax instanceof Float32Array) || !(octree.leafIndex instanceof Int32Array)) throw new Error(`${ERR} 팔진 트리 상자·리프 번호 배열이 없음`);
  if (octree.leafIndex.length !== nc) throw new Error(`${ERR} octree.leafIndex 길이(${octree.leafIndex.length}) 가 nodeCount(${nc}) 와 다름`);
  if (octree.boxMin.length !== 3 * nc || octree.boxMax.length !== 3 * nc) throw new Error(`${ERR} octree.boxMin/boxMax 길이가 3·nodeCount(${3 * nc}) 가 아님`);
  if (!Array.isArray(levels) || levels.length < 1) throw new Error(`${ERR} 계층의 단계 배열이 비었음`);
  for (const lv of levels) {
    if (!lv || !(lv.indices instanceof Uint32Array) || !(lv.leafStart instanceof Uint32Array) || lv.leafStart.length !== octree.leafCount + 1) {
      throw new Error(`${ERR} 단계 ${String(lv?.level)} 의 구간 배열이 올바르지 않음`);
    }
    const n = lv.indices.length;
    if (!(lv.positions instanceof Float32Array) || lv.positions.length !== 3 * n) throw new Error(`${ERR} 단계 ${String(lv.level)} 의 positions 가 Float32Array(3·n) 가 아님`);
    if (!(lv.normals instanceof Float32Array) || lv.normals.length !== 3 * n) throw new Error(`${ERR} 단계 ${String(lv.level)} 의 normals 가 Float32Array(3·n) 가 아님`);
    if (!(lv.colors instanceof Uint8Array) || lv.colors.length !== 3 * n) throw new Error(`${ERR} 단계 ${String(lv.level)} 의 colors 가 Uint8Array(3·n) 가 아님`);
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
 * 리프마다 단계를 고른다.
 * @param {import('../../../contracts/lod/index.mjs').Hierarchy} hierarchy
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {{thresholdPx:number}} opts thresholdPx = 허용 화면 오차 τ(px)
 * @returns {import('../../../contracts/lod/index.mjs').Selection}
 */
export function selectLevels(hierarchy, camera, opts) {
  assertHierarchyInput(hierarchy);
  checkCamera(camera);
  const thresholdPx = opts?.thresholdPx;
  if (!(typeof thresholdPx === 'number' && Number.isFinite(thresholdPx) && thresholdPx > 0)) throw new Error(`${ERR} thresholdPx 는 양의 유한수: ${String(thresholdPx)}`);
  const { octree, levels, edge0M } = hierarchy;
  const rule = screenErrorRule(camera, { thresholdPx, edge0M, levelCount: levels.length });
  const leafLevel = new Uint8Array(octree.leafCount).fill(NOT_DRAWN);
  let pointCount = 0;
  const mn = [0, 0, 0], mx = [0, 0, 0];
  for (let node = 0; node < octree.nodeCount; node++) {
    const k = octree.leafIndex[node];
    if (k < 0) continue;
    if (levels[0].leafStart[k + 1] === levels[0].leafStart[k]) continue; // 빈 리프는 NOT_DRAWN
    for (let a = 0; a < 3; a++) { mn[a] = octree.boxMin[3 * node + a]; mx[a] = octree.boxMax[3 * node + a]; }
    if (!boxMayBeVisible(camera, mn, mx)) continue;
    const l = rule.leaf(mn, mx).level;
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
  assertHierarchyInput(hierarchy);
  const { octree, levels } = hierarchy;
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
  let o = 0;
  for (let k = 0; k < octree.leafCount; k++) {
    const l = leafLevel[k];
    if (l === NOT_DRAWN) continue;
    const lv = levels[l];
    const s0 = lv.leafStart[k], s1 = lv.leafStart[k + 1];
    if (s1 === s0) continue;
    // 위치·법선·색 모두 리프 구간이 연속이라 한 번에 복사한다.
    positions.set(lv.positions.subarray(3 * s0, 3 * s1), 3 * o);
    normals.set(lv.normals.subarray(3 * s0, 3 * s1), 3 * o);
    colors.set(lv.colors.subarray(3 * s0, 3 * s1), 3 * o);
    o += s1 - s0;
  }
  return { format: 1, count: n, positions, normals, colors };
}
