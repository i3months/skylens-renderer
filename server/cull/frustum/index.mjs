// T08.1 절두체 컬링: 리프 상자가 시야 사각뿔과 확실히 안 겹칠 때만 0 으로 하는 마스크를 만든다.
// 시야 판정은 server/lod/select/view_check.mjs 의 boxMayBeVisibleSplat 을 쓴다(경계 규칙 공유, 거짓 제거 0).
// F-116: 점은 반경 r = fx·pointSizeM/(2d) px 원판으로 그려지므로 좌·우·위·아래 평면을 그 반경만큼 바깥으로 민다.
// opts.pointSizeM 이 없으면 원판 크기를 모르므로 좌·우·위·아래로는 아무것도 버리지 않는다(앞 z > 0 만 판정, 보수적).
// 빈 리프(levels[0] 구간이 빈 리프)는 그릴 점이 없으므로 0. 퇴화 시점이면 던지지 않고 전부 0.
import { boxMayBeVisibleSplat } from '../../lod/select/view_check.mjs';

import { isDegenerateView, degenerateCamera } from '../degenerate/index.mjs';

const ERR = 'cull:';

/** 하위 호환 별칭: 판정은 degenerate/index.mjs 의 isDegenerateView 하나만 쓴다(F-120). */
export const isDegenerateViewLocal = isDegenerateView;

function assertHierarchyChecked(h) {
  const oc = h?.octree;
  if (!oc || !(oc.leafIndex instanceof Int32Array) || !(oc.boxMin instanceof Float32Array) || !(oc.boxMax instanceof Float32Array)) {
    throw new Error(`${ERR} 계층(octree)이 올바르지 않음`);
  }
  if (!Number.isInteger(oc.leafCount) || oc.leafCount < 1 || !Number.isInteger(oc.nodeCount)
    || oc.leafIndex.length < oc.nodeCount || oc.boxMin.length < 3 * oc.nodeCount || oc.boxMax.length < 3 * oc.nodeCount) {
    throw new Error(`${ERR} octree 배열 길이가 nodeCount·leafCount 와 맞지 않음`);
  }
  // leafIndex: 값은 -1(내부 노드) 또는 [0, leafCount), 중복 금지, 리프 수 = leafCount (distance 와 같은 규칙)
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
  if (!(l0 instanceof Uint32Array) || l0.length !== oc.leafCount + 1) throw new Error(`${ERR} levels[0].leafStart 길이가 leafCount+1 이 아님`);
}

/** 계층 구조 검사. 필드 읽기 중 예외(접근자·Proxy)도 'cull:' 오류로 바꿔 던진다(F-145). 리프 0 개(leafCount < 1)는 거부. */
function assertHierarchyLocal(h) {
  try {
    assertHierarchyChecked(h);
  } catch (e) {
    if (typeof e?.message === 'string' && e.message.startsWith(ERR)) throw e;
    throw new Error(`${ERR} 계층 필드를 읽는 중 예외: ${String(e?.message ?? e)}`);
  }
}

/** opts 검사 후 pointSizeM(없으면 undefined)을 돌려준다. */
function pointSizeOf(opts) {
  if (opts === undefined || opts === null) return undefined;
  if (typeof opts !== 'object') throw new Error(`${ERR} opts 는 객체여야 함`);
  const s = opts.pointSizeM;
  if (s === undefined || s === null) return undefined;
  if (!(typeof s === 'number' && Number.isFinite(s) && s >= 0)) throw new Error(`${ERR} pointSizeM 은 0 이상의 유한 수여야 함: ${String(s)}`);
  return s;
}

/**
 * @param {import('../../../contracts/lod/index.mjs').Hierarchy} hierarchy
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {{pointSizeM?:number}} [opts] pointSizeM = 래스터 원판 지름(m). 없으면 좌·우·위·아래 제거 없음
 * @returns {Uint8Array} 길이 leafCount, 1 = 남김
 */
export function frustumCull(hierarchy, camera, opts) {
  assertHierarchyLocal(hierarchy);
  const pointSizeM = pointSizeOf(opts);
  const oc = hierarchy.octree;
  const mask = new Uint8Array(oc.leafCount);
  if (degenerateCamera(camera)) return mask;
  const ls = hierarchy.levels[0].leafStart;
  const mn = [0, 0, 0], mx = [0, 0, 0];
  for (let node = 0; node < oc.nodeCount; node++) {
    const k = oc.leafIndex[node];
    if (k < 0) continue;
    if (ls[k + 1] === ls[k]) continue; // 빈 리프
    for (let a = 0; a < 3; a++) { mn[a] = oc.boxMin[3 * node + a]; mx[a] = oc.boxMax[3 * node + a]; }
    if (boxMayBeVisibleSplat(camera, mn, mx, pointSizeM)) mask[k] = 1;
  }
  return mask;
}
