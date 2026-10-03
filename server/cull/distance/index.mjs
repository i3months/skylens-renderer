// 거리 컬링(T08.4). 카메라로부터의 거리 > maxDistanceM 인 리프를 제거한다.
// 거리 = 카메라 중심과 리프 상자의 최소 거리. 경계(거리 = maxDistanceM)는 보수적으로 남긴다.

import { cameraCenter, boxDistanceM } from '../../lod/select/screen_error.mjs';
import { degenerateCamera } from '../degenerate/index.mjs';
import { guardHierarchyRead } from '../degenerate/hierarchy_guard.mjs';

const ERR = 'cull:';

function assertHierarchy(h) {
  const oc = h?.octree;
  if (!oc || !(oc.leafIndex instanceof Int32Array) || !(oc.boxMin instanceof Float32Array) || !(oc.boxMax instanceof Float32Array)) {
    throw new Error(`${ERR} 계층(octree)이 올바르지 않음`);
  }
  // 리프 0 개 계층(leafCount < 1)은 구조 오류(F-145)
  if (!Number.isInteger(oc.leafCount) || oc.leafCount < 1 || !Number.isInteger(oc.nodeCount) || oc.nodeCount < 0
    || oc.leafIndex.length < oc.nodeCount || oc.boxMin.length < 3 * oc.nodeCount || oc.boxMax.length < 3 * oc.nodeCount) {
    throw new Error(`${ERR} octree 배열 길이가 nodeCount·leafCount 와 맞지 않음`);
  }
  // leafIndex: 값은 -1(내부 노드) 또는 [0, leafCount), 리프<->노드 일대일
  const seen = new Uint8Array(oc.leafCount);
  let leaves = 0;
  for (let n = 0; n < oc.nodeCount; n++) {
    const k = oc.leafIndex[n];
    if (k === -1) continue;
    if (k < 0 || k >= oc.leafCount || seen[k]) {
      throw new Error(`${ERR} leafIndex[${n}]=${k} 가 범위를 벗어났거나 중복됨`);
    }
    seen[k] = 1;
    leaves++;
  }
  if (leaves !== oc.leafCount) {
    throw new Error(`${ERR} leafIndex 의 리프 수(${leaves})가 leafCount(${oc.leafCount}) 와 다름`);
  }
  const l0 = h.levels?.[0]?.leafStart;
  if (!(l0 instanceof Uint32Array) || l0.length !== oc.leafCount + 1) {
    throw new Error(`${ERR} levels[0].leafStart 길이가 leafCount+1 이 아님`);
  }
}

/**
 * 거리 기반으로 리프를 걸러 낸다. 카메라 중심~리프 상자 최소 거리 > maxDistanceM 이면 0(제거).
 * 경계(거리 = maxDistanceM)는 1(남김). 빈 리프도 0.
 *
 * @param {import('../../../contracts/lod/index.mjs').Hierarchy} hierarchy
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {Object} opts
 * @param {number} opts.maxDistanceM  최대 거리(m). NaN·음수면 빈 마스크, Infinity 면 비어있지 않은 리프 전부.
 * @returns {Uint8Array} LeafMask 길이 leafCount, 1 = 남김, 0 = 제거
 */
export function distanceCull(hierarchy, camera, opts = {}) {
  if (opts === null || typeof opts !== 'object') throw new Error(`${ERR} opts 는 객체여야 함`);
  let { maxDistanceM } = opts;
  // undefined = 생략(전부 남김). 그 외 비숫자(null·문자열 등)는 오류.
  if (maxDistanceM === undefined) maxDistanceM = Infinity;
  else if (typeof maxDistanceM !== 'number') throw new Error(`${ERR} maxDistanceM 은 숫자여야 함`);
  // 접근자·Proxy 예외는 'cull:' 오류로 바꾼다(F-148)
  const { octree, levels } = guardHierarchyRead(() => {
    assertHierarchy(hierarchy);
    return { octree: hierarchy.octree, levels: hierarchy.levels };
  });
  const { leafCount, nodeCount, boxMin, boxMax, leafIndex } = octree;

  const mask = new Uint8Array(leafCount);

  // 입력 검증: maxDistanceM 이 NaN 이거나 음수면 빈 마스크
  if (Number.isNaN(maxDistanceM) || maxDistanceM < 0) {
    return mask; // 전부 0
  }

  // 퇴화 시점(NaN·Infinity 등)이면 전부 0
  if (degenerateCamera(camera)) return mask;

  // maxDistanceM = Infinity 면 비어있지 않은 리프 전부 남김
  if (maxDistanceM === Infinity) {
    const level0 = levels[0];
    for (let k = 0; k < leafCount; k++) {
      if (level0.leafStart[k] < level0.leafStart[k + 1]) {
        mask[k] = 1;
      }
    }
    return mask;
  }

  // 카메라 중심 구하기
  const C = cameraCenter(camera);

  // boxMin/boxMax 는 노드 순서이므로 노드를 돌며 leafIndex 로 리프 번호를 얻는다.
  const level0 = levels[0];
  const mn = [0, 0, 0];
  const mx = [0, 0, 0];
  for (let node = 0; node < nodeCount; node++) {
    const k = leafIndex[node];
    if (k < 0) continue; // 내부 노드
    if (level0.leafStart[k] >= level0.leafStart[k + 1]) continue; // 빈 리프
    for (let a = 0; a < 3; a++) {
      mn[a] = boxMin[3 * node + a];
      mx[a] = boxMax[3 * node + a];
    }
    // 거리 > maxDistanceM 이면 제거(0), 그 외(<=)는 남김(1)
    mask[k] = boxDistanceM(C, mn, mx) > maxDistanceM ? 0 : 1;
  }

  return mask;
}
