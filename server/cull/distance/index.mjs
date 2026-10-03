// 거리 컬링(T08.4). 카메라로부터의 거리 > maxDistanceM 인 리프를 제거한다.
// 거리 = 카메라 중심과 리프 상자의 최소 거리. 경계(거리 = maxDistanceM)는 보수적으로 남긴다.

import { cameraCenter, boxDistanceM } from '../../lod/select/screen_error.mjs';

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
  const { maxDistanceM } = opts;
  const { octree, levels } = hierarchy;
  const { leafCount, boxMin, boxMax } = octree;

  const mask = new Uint8Array(leafCount);

  // 입력 검증: maxDistanceM 이 NaN 이거나 음수면 빈 마스크
  if (Number.isNaN(maxDistanceM) || maxDistanceM < 0) {
    return mask; // 전부 0
  }

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

  // 각 리프의 거리 계산
  for (let k = 0; k < leafCount; k++) {
    // 먼저 빈 리프 체크: level 0 에 점이 없으면 제거
    const level0 = levels[0];
    if (level0.leafStart[k] >= level0.leafStart[k + 1]) {
      // 빈 리프
      mask[k] = 0;
      continue;
    }

    // 리프 상자 경계 가져오기
    const i3 = k * 3;
    const mn = boxMin.subarray(i3, i3 + 3);
    const mx = boxMax.subarray(i3, i3 + 3);

    // 카메라 중심~상자의 최소 거리 계산
    const dist = boxDistanceM(C, mn, mx);

    // 거리 > maxDistanceM 이면 제거(0), 그 외(<=)는 남김(1)
    mask[k] = dist > maxDistanceM ? 0 : 1;
  }

  return mask;
}
