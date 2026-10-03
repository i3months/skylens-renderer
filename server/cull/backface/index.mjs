// T08.2 법선 기반 뒷면 제거(조각 단위 법선 원뿔). 새로 작성한 코드.
// 리프마다 단계 0 점 법선들의 원뿔(axis, cosHalf)을 만들고, 시점에서 리프 상자 안 '어느 점에서도' 모든 법선이
// 카메라를 등지는 것이 확실하고(1단계), 그 리프의 화면 영역이 앞쪽 점들로 '확실히 덮였을' 때(2단계)만 리프를 버린다.
// 점 형식·법선 의미는 renderer_basis 그대로(법선이 카메라 쪽이면 앞면).
//
// 1단계 판정(수식): 점 p 에서 시선 v = C − p, 뒷면은 n·v < 0. 법선 n 이 axis 에서 γ=acos(cosHalf) 이내이므로
//   angle(n, v) ≥ angle(axis, v) − γ. angle(axis, v) > 90° + γ 이면 n·v < 0 이 확실하다. 이는
//   axis·v/|v| < −sinγ  ⇔  f(p) = axis·(C−p) + sinγ·|C−p| < 0 (γ < 90° 일 때만 의미가 있다).
//   f 는 p 의 볼록 함수(선형 + 노름)이므로 상자 위 최댓값은 꼭짓점 8개 중에 있다 → 8 꼭짓점이 모두 f < −여유 이면 후보.
//   카메라가 상자 안이면 f(C) = 0 이 상자 안에 있어 최댓값 ≥ 0 이므로 자동으로 남긴다.
// 수치 여유(반올림 흡수용이며 화질 조정 상수가 아니다): cosHalf 는 최솟값에서 CONE_SLACK 만큼 내림(Float32 반올림·비단위 법선),
//   상자는 BOX_PAD 만큼 부풀림, f 는 F_MARGIN 보다 확실히 음수일 때만 후보.
//
// 2단계(덮임 판정, F-117): 참조 래스터(renderPoints)는 법선을 쓰지 않는다. 그래서 1단계만으로는 '등진 점'이
//   (a) 앞면 표본 사이 틈, (b) 실루엣 바깥으로 원판 반경 r = fx·s/(2d) 만큼 번진 띠(예: 낮은 시점에서 지붕 앞 가장자리)
//   를 통해 그려지고, 그 리프를 버리면 영상이 바뀐다(flat_boxes low_close_box SSIM 하락 1.55e-2).
//   각도 여유로는 막을 수 없다: (b) 는 등진 각도와 무관하게 실루엣 위치에서 생기고, 원판 번짐에서 유도되는 각 여유
//   δ = asin((s/2)/d) 는 이 장면들에서 2° 미만인데 기준을 맞추려면 약 30° 가 필요했다(측정은 experiments/culling_F117.md).
//   그래서 occlusion 단계의 '확실히 덮임' 판정(server/cull/occlusion)을 그대로 재사용한다:
//   가림막 = 1단계 후보가 아닌 리프(앞면·혼합 리프)의 단계 0 점 전부, 같은 점 지름 s 로 만든 깊이 피라미드.
//   피라미드 칸 값 V 는 '그 칸의 모든 픽셀이 깊이 ≤ V 인 가림막 점 원판으로 확실히 덮인다'는 상한이고,
//   후보 리프는 상자 최소 깊이 zmin 이 (원판 반경 상한 + 1 px 로 넓힌) 화면 사각형의 모든 칸 V 보다 엄격히 클 때만 버린다.
//   이때 버린 리프의 점은 참조 래스터의 어느 픽셀에서도 이기지 못한다(깊이가 엄격히 더 멀고 동률은 먼저 온 점이 이김).
//   따라서 버린 리프를 뺀 렌더는 원본 전체 렌더와 픽셀 단위로 같다 → SSIM 하락 = 0 (점 지름이 렌더와 같을 때).
//   여기 쓰이는 여유(블록 반대각만큼 줄인 원판, rmax+1 px 사각형, REL/ABS 1e-6)는 모두 occlusion 모듈의 식 그대로이며 새 상수가 없다.
//   opts.requireCover = false 이면 2단계를 끄고 1단계(순수 법선 판정)만 쓴다(기하 성질 시험·비교 측정용).
import { assertHierarchyInput } from '../../lod/select/index.mjs';
import { cameraCenter } from '../../lod/select/screen_error.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { buildDepthPyramid, occlusionCull, DEFAULT_POINT_SIZE_M } from '../occlusion/index.mjs';

const ERR = 'cull:';
/** cosHalf 를 최솟값에서 내리는 양(Float32 반올림·법선 길이 오차 여유). */
export const CONE_SLACK = 1e-5;
/** 스치는 면 여유(도, 선택). 화질 보장은 2단계 덮임 판정이 맡으므로 기본 0(각도 여유로는 실루엣 번짐을 막을 수 없다: 머리말 참조). */
export const DEFAULT_MARGIN_DEG = 0;
/** 덮임 판정용 깊이 피라미드 크기(occlusion 기본과 같다). */
export const COVER_PYRAMID_SIZE = 64;
const BOX_PAD = 1e-3; // 상자 부풀림(m)
const F_MARGIN = 1e-3; // f 가 이만큼 음수여야 제거(m)

function checkHierarchy(h) {
  try { assertHierarchyInput(h); } catch (e) { throw new Error(`${ERR} 계층이 올바르지 않음: ${e.message}`); }
}

// 퇴화 시점(NaN·Infinity·해상도/초점 0 이하·R 이 회전이 아님)이면 true. 던지지 않는다.
function degenerate(camera) {
  try { assertCamera(camera); return false; } catch { return true; }
}

// 리프 k → 노드 번호
function leafNodes(oc) {
  const out = new Int32Array(oc.leafCount).fill(-1);
  for (let node = 0; node < oc.nodeCount; node++) if (oc.leafIndex[node] >= 0) out[oc.leafIndex[node]] = node;
  return out;
}

/**
 * 리프마다 법선 원뿔을 만든다. levels[0].normals(원본 전부의 단위 법선, 길이 0 은 (0,0,0)) 를 쓴다.
 * 길이 0 법선이 하나라도 있거나 합이 0 이면 cosHalf = −1(전체 구).
 * @returns {import('../../../contracts/cull/index.mjs').NormalCones}
 */
export function leafNormalCones(hierarchy) {
  checkHierarchy(hierarchy);
  const { octree, levels } = hierarchy;
  const L = octree.leafCount;
  const { normals, leafStart } = levels[0];
  const axis = new Float32Array(3 * L);
  const cosHalf = new Float32Array(L).fill(-1);
  for (let k = 0; k < L; k++) {
    const a = leafStart[k], b = leafStart[k + 1];
    axis[3 * k + 1] = 1; // 기본 축(원뿔 = 전체 구일 때도 단위 길이를 지킨다)
    if (a === b) continue;
    let sx = 0, sy = 0, sz = 0, anyZero = false;
    for (let s = a; s < b; s++) {
      const x = normals[3 * s], y = normals[3 * s + 1], z = normals[3 * s + 2];
      if (!(Math.hypot(x, y, z) > 0)) { anyZero = true; break; }
      sx += x; sy += y; sz += z;
    }
    if (anyZero) continue;
    const len = Math.hypot(sx, sy, sz);
    if (!(len > 0) || !Number.isFinite(len)) continue;
    // 저장될 Float32 축으로 최솟값을 구한다(판정이 쓰는 축과 같다)
    const ax = Math.fround(sx / len), ay = Math.fround(sy / len), az = Math.fround(sz / len);
    let m = Infinity;
    for (let s = a; s < b; s++) {
      const d = normals[3 * s] * ax + normals[3 * s + 1] * ay + normals[3 * s + 2] * az;
      if (d < m) m = d;
    }
    axis[3 * k] = ax; axis[3 * k + 1] = ay; axis[3 * k + 2] = az;
    cosHalf[k] = Math.max(-1, Math.fround(m - CONE_SLACK));
    if (cosHalf[k] > m - CONE_SLACK * 0.5) cosHalf[k] = Math.max(-1, Math.fround(m - 2 * CONE_SLACK)); // fround 올림 방지
  }
  return { axis, cosHalf };
}

function checkCones(cones, L) {
  if (!cones || !(cones.axis instanceof Float32Array) || !(cones.cosHalf instanceof Float32Array)) throw new Error(`${ERR} cones 는 {axis, cosHalf} Float32Array 여야 함`);
  if (cones.axis.length !== 3 * L || cones.cosHalf.length !== L) throw new Error(`${ERR} cones 길이가 리프 수(${L})와 맞지 않음`);
}

/**
 * 뒷면 컬링. 리프 상자 안 어느 점에서도 원뿔 안 모든 법선이 카메라를 등지는 것이 확실하고(1단계),
 * 그 리프의 화면 영역이 앞쪽 가림막 점들로 확실히 덮일 때(2단계)만 0.
 * 퇴화 시점이면 전부 0(빈 마스크), 던지지 않는다.
 * opts.marginDeg(기본 DEFAULT_MARGIN_DEG): 스치는 면 여유각.
 * opts.pointSizeM(기본 occlusion 의 DEFAULT_POINT_SIZE_M = renderPoints 기본 0.05): 덮임 판정의 점 지름. 렌더 점 지름과 같게 준다.
 * opts.requireCover(기본 true): false 면 2단계를 끈다(순수 법선 판정).
 * @returns {Uint8Array}
 */
export function backfaceCull(hierarchy, camera, cones, opts) {
  const marginDeg = opts?.marginDeg ?? DEFAULT_MARGIN_DEG;
  const requireCover = opts?.requireCover ?? true;
  if (typeof requireCover !== 'boolean') throw new Error(`${ERR} requireCover 는 boolean 이어야 함: ${String(requireCover)}`);
  const pointSizeM = opts?.pointSizeM ?? DEFAULT_POINT_SIZE_M;
  if (typeof pointSizeM !== 'number' || !Number.isFinite(pointSizeM) || !(pointSizeM > 0)) throw new Error(`${ERR} pointSizeM 은 양의 유한 수여야 함: ${String(pointSizeM)}`);
  if (typeof marginDeg !== 'number' || !Number.isFinite(marginDeg) || marginDeg < 0 || marginDeg >= 90) throw new Error(`${ERR} marginDeg 는 [0, 90) 의 유한 수여야 함: ${String(marginDeg)}`);
  const mc = Math.cos(marginDeg * Math.PI / 180), ms = Math.sin(marginDeg * Math.PI / 180);
  checkHierarchy(hierarchy);
  const { octree } = hierarchy;
  const L = octree.leafCount;
  checkCones(cones, L);
  if (degenerate(camera)) return new Uint8Array(L);
  const C = cameraCenter(camera);
  const mask = new Uint8Array(L).fill(1);
  const nodes = leafNodes(octree);
  const { axis, cosHalf } = cones;
  for (let k = 0; k < L; k++) {
    const c = cosHalf[k];
    if (!(c > 0)) continue; // γ ≥ 90° 이면 제거 불가(NaN 도 남김)
    const node = nodes[k];
    if (node < 0) continue;
    const ax = axis[3 * k], ay = axis[3 * k + 1], az = axis[3 * k + 2];
    const sg = Math.sqrt(Math.max(0, 1 - c * c));
    if (sg * ms + c * mc <= 0 || c * mc - sg * ms <= 0) continue; // γ+δ ≥ 90° 면 제거 불가
    const s = sg * mc + c * ms + 1e-6; // sin(γ+δ) (위로 여유)
    let removable = true;
    for (let v = 0; v < 8 && removable; v++) {
      const px = (v & 1 ? octree.boxMax[3 * node] + BOX_PAD : octree.boxMin[3 * node] - BOX_PAD);
      const py = (v & 2 ? octree.boxMax[3 * node + 1] + BOX_PAD : octree.boxMin[3 * node + 1] - BOX_PAD);
      const pz = (v & 4 ? octree.boxMax[3 * node + 2] + BOX_PAD : octree.boxMin[3 * node + 2] - BOX_PAD);
      const dx = C[0] - px, dy = C[1] - py, dz = C[2] - pz;
      const f = ax * dx + ay * dy + az * dz + s * Math.hypot(dx, dy, dz);
      if (!(f < -F_MARGIN)) removable = false;
    }
    if (removable) mask[k] = 0;
  }
  if (!requireCover) return mask;
  return coverFilter(hierarchy, camera, mask, pointSizeM);
}

// 2단계: 1단계 후보(mask 0) 중 화면 영역이 앞쪽 가림막(mask 1 리프의 단계 0 점)으로 확실히 덮인 것만 0 으로 남긴다.
// 후보가 없으면 피라미드를 만들지 않는다.
function coverFilter(hierarchy, camera, candidates, pointSizeM) {
  const L = candidates.length;
  let any = false;
  for (let k = 0; k < L && !any; k++) if (candidates[k] === 0) any = true;
  const out = new Uint8Array(L).fill(1);
  if (!any) return out;
  const pyramid = buildDepthPyramid(hierarchy, camera, { size: COVER_PYRAMID_SIZE, pointSizeM, occluderLevel: 0, occluderMask: candidates });
  const hidden = occlusionCull(hierarchy, camera, pyramid);
  for (let k = 0; k < L; k++) if (candidates[k] === 0 && hidden[k] === 0) out[k] = 0;
  return out;
}
