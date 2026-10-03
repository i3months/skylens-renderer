// T08.10 퇴화 시점 처리. 계약: contracts/cull/index.mjs 의 "퇴화 시점", CULL_API.degenerate.
// 퇴화 시점 = 카메라가 NaN·Infinity 를 가지거나, 해상도가 양의 정수가 아니거나 픽셀 수가 MAX_PIXELS 초과이거나, 초점거리가 유한 양수가 아니거나, 시야각이 1e-6 rad 미만이거나,
// R 이 회전(정규직교·det=+1)이 아니거나, t 가 유한한 3-벡터가 아닌 경우. isDegenerateView 는 어떤 입력에도 던지지 않는다.
// 지면 아래 카메라(중심이 모든 상자보다 아래)는 퇴화가 아니다: 여기서는 위치를 보지 않는다.
import { assertHierarchyInput } from '../../lod/select/index.mjs';
import { MAX_PIXELS } from '../../../contracts/raster/index.mjs';

const ORTHO_TOL = 1e-6;
/** 시야각 하한(rad). 이보다 좁으면 퇴화. */
export const MIN_FOV_RAD = 1e-6;
/** 해상도 한 변 상한(px). 이보다 크면 퇴화(버퍼 할당 불가·비현실). 클라이언트 복제본과 같은 값. */
export const MAX_RESOLUTION_PX = 1e6;

const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const isPosFin = (v) => isFin(v) && v > 0;

function checkCamera(camera) {
  if (!camera || typeof camera !== 'object') return true;
  const { width, height, K, R, t } = camera;
  if (!isPosFin(width) || !isPosFin(height)) return true;
  if (width > MAX_RESOLUTION_PX || height > MAX_RESOLUTION_PX) return true;
  // 래스터 조건(assertCamera 와 같음): 해상도는 정수, 픽셀 수는 MAX_PIXELS 이하.
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > MAX_PIXELS) return true;
  if (!K || typeof K !== 'object') return true;
  if (!isPosFin(K.fx) || !isPosFin(K.fy) || !isFin(K.cx) || !isFin(K.cy)) return true;
  // 시야각: 가로 2·atan(width/(2fx)), 세로 2·atan(height/(2fy)). 둘 중 하나라도 1e-6 rad 미만이면 퇴화.
  if (2 * Math.atan(width / (2 * K.fx)) < MIN_FOV_RAD || 2 * Math.atan(height / (2 * K.fy)) < MIN_FOV_RAD) return true;
  if (!Array.isArray(R) || R.length !== 9) return true;
  for (let i = 0; i < 9; i++) if (typeof R[i] !== 'number' || !Number.isFinite(R[i])) return true;
  if (!Array.isArray(t) || t.length !== 3) return true;
  for (let i = 0; i < 3; i++) if (typeof t[i] !== 'number' || !Number.isFinite(t[i])) return true;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += R[i * 3 + k] * R[j * 3 + k];
      if (!(Math.abs(s - (i === j ? 1 : 0)) <= ORTHO_TOL)) return true;
    }
  }
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  return !(Math.abs(det - 1) <= ORTHO_TOL);
}

/** 퇴화 시점이면 true. 절대 던지지 않는다(접근자가 던져도 true). */
export function isDegenerateView(camera) {
  try { return checkCamera(camera); } catch { return true; }
}

/**
 * 카메라 구조 검사(F-132). 구조가 틀리면(객체 아님·width/height/K·R·t 필드 누락·수가 아닌 값·R·t 가 일반 배열이 아님·길이 틀림) 'cull:' 오류를 던진다.
 * 값이 NaN·Infinity·0 이하·비회전인 것은 구조 오류가 아니라 퇴화 시점이다(isDegenerateView 가 판정).
 */
export function assertCameraShape(camera) {
  const ERR = 'cull:';
  if (!camera || typeof camera !== 'object') throw new Error(`${ERR} 카메라가 객체가 아님`);
  const { K, R, t } = camera;
  if (typeof camera.width !== 'number' || typeof camera.height !== 'number') throw new Error(`${ERR} 카메라 width·height 는 수여야 함`);
  if (!K || typeof K !== 'object' || !['fx', 'fy', 'cx', 'cy'].every((n) => typeof K[n] === 'number')) throw new Error(`${ERR} 카메라 K 는 fx·fy·cx·cy 수를 가진 객체여야 함`);
  if (!Array.isArray(R) || R.length !== 9) throw new Error(`${ERR} 카메라 R 은 수 9개 배열이어야 함`);
  for (let i = 0; i < 9; i++) if (typeof R[i] !== 'number') throw new Error(`${ERR} 카메라 R 은 수 9개 배열이어야 함`);
  if (!Array.isArray(t) || t.length !== 3) throw new Error(`${ERR} 카메라 t 는 수 3개 배열이어야 함`);
  for (let i = 0; i < 3; i++) if (typeof t[i] !== 'number') throw new Error(`${ERR} 카메라 t 는 수 3개 배열이어야 함`);
}

/** 모든 컬링 단계의 카메라 입구: 구조 오류는 'cull:' 로 던지고, 값 퇴화면 true 를 돌려준다(F-132). */
export function degenerateCamera(camera) {
  assertCameraShape(camera);
  return isDegenerateView(camera);
}

/** 빈 마스크: 길이 leafCount, 전부 0(아무것도 남기지 않음). 계층이 올바르지 않으면 'cull:' 오류. */
export function emptyMask(hierarchy) {
  assertHierarchyForCull(hierarchy);
  return new Uint8Array(hierarchy.octree.leafCount);
}

/** 계층 입력 검사. assertHierarchyInput 의 'lod:' 오류를 'cull:' 로 바꿔 던진다(원인 메시지 보존). */
export function assertHierarchyForCull(hierarchy) {
  try {
    assertHierarchyInput(hierarchy);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.startsWith('lod:')) throw new Error(`cull:${msg.slice(4)}`, { cause: e });
    throw new Error(`cull: ${msg}`, { cause: e });
  }
}
