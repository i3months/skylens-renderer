// T08.1 절두체 컬링: 리프 상자가 시야 사각뿔과 확실히 안 겹칠 때만 0 으로 하는 마스크를 만든다.
// 시야 판정은 server/lod/select/view_check.mjs 의 boxMayBeVisibleSplat 을 쓴다(경계 규칙 공유, 거짓 제거 0).
// F-116: 점은 반경 r = fx·pointSizeM/(2d) px 원판으로 그려지므로 좌·우·위·아래 평면을 그 반경만큼 바깥으로 민다.
// opts.pointSizeM 이 없으면 원판 크기를 모르므로 좌·우·위·아래로는 아무것도 버리지 않는다(앞 z > 0 만 판정, 보수적).
// 빈 리프(levels[0] 구간이 빈 리프)는 그릴 점이 없으므로 0. 퇴화 시점이면 던지지 않고 전부 0.
import { boxMayBeVisibleSplat } from '../../lod/select/view_check.mjs';

const ERR = 'cull:';

/**
 * 퇴화 시점 최소 판정(T08.10 의 server/cull/degenerate 가 생기면 그쪽으로 교체).
 * NaN·Infinity, 해상도·초점거리 ≤ 0, R 이 회전이 아님이면 true. 던지지 않는다.
 */
export function isDegenerateViewLocal(camera) {
  if (!camera || typeof camera !== 'object') return true;
  const { width, height, K, R, t } = camera;
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) return true;
  if (!K || !(Number.isFinite(K.fx) && K.fx > 0 && Number.isFinite(K.fy) && K.fy > 0 && Number.isFinite(K.cx) && Number.isFinite(K.cy))) return true;
  if (!R || R.length !== 9 || !t || t.length !== 3) return true;
  for (let i = 0; i < 9; i++) if (typeof R[i] !== 'number' || !Number.isFinite(R[i])) return true;
  for (let i = 0; i < 3; i++) if (typeof t[i] !== 'number' || !Number.isFinite(t[i])) return true;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += R[i * 3 + k] * R[j * 3 + k];
      if (Math.abs(s - (i === j ? 1 : 0)) > 1e-6) return true;
    }
  }
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  return !(Math.abs(det - 1) <= 1e-6);
}

function assertHierarchyLocal(h) {
  const oc = h?.octree;
  if (!oc || !(oc.leafIndex instanceof Int32Array) || !(oc.boxMin instanceof Float32Array) || !(oc.boxMax instanceof Float32Array)) {
    throw new Error(`${ERR} 계층(octree)이 올바르지 않음`);
  }
  if (!Number.isInteger(oc.leafCount) || oc.leafCount < 0 || !Number.isInteger(oc.nodeCount)
    || oc.leafIndex.length < oc.nodeCount || oc.boxMin.length < 3 * oc.nodeCount || oc.boxMax.length < 3 * oc.nodeCount) {
    throw new Error(`${ERR} octree 배열 길이가 nodeCount·leafCount 와 맞지 않음`);
  }
  const l0 = h.levels?.[0]?.leafStart;
  if (!(l0 instanceof Uint32Array) || l0.length !== oc.leafCount + 1) throw new Error(`${ERR} levels[0].leafStart 길이가 leafCount+1 이 아님`);
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
  if (isDegenerateViewLocal(camera)) return mask;
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
