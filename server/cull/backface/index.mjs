// 법선 기반 뒷면 제거(조각 단위 법선 원뿔).
// 리프마다 단계 0 점 법선들의 원뿔(axis, cosHalf)을 만들고, 시점에서 리프 상자 안 '어느 점에서도' 모든 법선이
// 카메라를 등지는 것이 확실하고(1단계), 그 리프의 화면 영역이 앞쪽 점들로 '확실히 덮였을' 때(2단계)만 리프를 버린다.
// 점 형식·법선 의미는 renderer_basis 그대로(법선이 카메라 쪽이면 앞면).
//
// 1단계 판정(수식): 점 p 에서 시선 v = C − p, 뒷면은 n·v < 0. 법선 n 이 axis 에서 γ=acos(cosHalf) 이내이므로
//   angle(n, v) ≥ angle(axis, v) − γ. angle(axis, v) > 90° + γ 이면 n·v < 0 이 확실하다. 이는
//   axis·v/|v| < −sinγ  ⇔  f(p) = axis·(C−p) + sinγ·|C−p| < 0 (γ < 90° 일 때만 의미가 있다).
//   f 는 p 의 볼록 함수(선형 + 노름)이므로 상자 위 최댓값은 꼭짓점 8개 중에 있다 → 8 꼭짓점이 모두 f < −F_MARGIN 이면 후보.
//   카메라가 상자 안이면 f(C) = 0 이 상자 안에 있어 최댓값 ≥ 0 이므로 자동으로 남긴다.
// 수치 여유(반올림 흡수용이며 화질 조정 상수가 아니다): cosHalf 는 최솟값에서 CONE_SLACK 만큼 내림(Float32 반올림·비단위 법선),
//   상자는 BOX_PAD 만큼 부풀림, f 는 F_MARGIN 보다 확실히 음수일 때만 후보.
//
// 2단계(덮임 판정): 참조 래스터(renderPoints)는 법선을 쓰지 않으므로, 등진 점도 앞면 표본 사이 틈이나 실루엣 바깥으로
//   번진 원판(반경 r = fx·s/(2d))을 통해 그려질 수 있다. 1단계만으로는 그 점을 버려 영상이 바뀔 수 있으므로,
//   occlusion 단계의 '확실히 덮임' 판정(server/cull/occlusion)을 그대로 재사용한다:
//   가림막 = 1단계 후보가 아닌 리프(앞면·혼합 리프)의 단계 0 점, 같은 점 지름 s 로 만든 깊이 피라미드.
//   피라미드 칸 값 V 는 '그 칸의 모든 픽셀이 깊이 ≤ V 인 가림막 점 원판으로 확실히 덮인다'는 상한이고,
//   후보 리프는 상자 최소 깊이 zmin 이 (원판 반경 상한 + 1 px 로 넓힌) 화면 사각형의 모든 칸 V 보다 엄격히 클 때만 버린다.
//   이때 버린 리프의 점은 참조 래스터의 어느 픽셀에서도 이기지 못한다(깊이가 엄격히 더 멀고 동률은 먼저 온 점이 이김).
//   보장 조건: 덮임 판정의 점 지름 = 렌더 점 지름, 가림막 점은 원본의 부분집합(단계 0) → 버린 리프를 뺀 렌더는 원본 전체 렌더와
//   픽셀 단위로 같다. 여기 쓰이는 여유(블록 반대각만큼 줄인 원판, rmax+1 px 사각형, REL/ABS 1e-6)는 occlusion 모듈의 식 그대로다.
//   가림막 제한: 후보 사각형이 닿는 피라미드 칸과 원판이 겹칠 수 있는 가림막 리프만 투영한다. 판정은 그 칸들의 값만 읽고
//   (상위 칸이 실패하면 사각형과 겹치는 자식으로만 내려간다), 가림막을 빼면 칸 값은 커지기만 하므로 결과는 전체 가림막과 같고
//   어떤 경우에도 제거가 늘지 않는다(보장 유지).
//   opts.pointSizeM 이 없으면 렌더 지름을 모르므로 보장 조건을 확인할 수 없다 → 2단계 후보를 전부 남긴다(제거 0).
//   opts.requireCover = false 이면 2단계를 끄고 1단계(순수 법선 판정)만 쓴다(기하 성질 시험·비교 측정용).
import { assertHierarchyInput } from '../../lod/select/index.mjs';
import { cameraCenter } from '../../lod/select/screen_error.mjs';
import { degenerateCamera } from '../degenerate/index.mjs';
import { buildDepthPyramid, occlusionCull, NEAR_M } from '../occlusion/index.mjs';

const ERR = 'cull:';
/** cosHalf 를 최솟값에서 내리는 양(Float32 반올림·법선 길이 오차 여유). */
export const CONE_SLACK = 1e-5;
/** 스치는 면 여유(도, 선택). 화질 보장은 2단계 덮임 판정이 맡으므로 기본 0(실루엣 밖 원판 번짐은 등진 각도와 무관하다). */
export const DEFAULT_MARGIN_DEG = 0;
/** 덮임 판정용 깊이 피라미드 크기(occlusion 기본과 같다). */
export const COVER_PYRAMID_SIZE = 64;
const BOX_PAD = 1e-3; // 상자 부풀림(m)
const F_MARGIN = 1e-3; // f 가 이만큼 음수여야 제거(m)

function checkHierarchy(h) {
  try { assertHierarchyInput(h); } catch (e) { throw new Error(`${ERR} 계층이 올바르지 않음: ${e.message}`); }
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
 * opts.pointSizeM: 덮임 판정의 점 지름. 렌더 점 지름과 같게 준다. 없으면(undefined) 2단계 후보를 전부 남긴다(제거 0).
 * opts.requireCover(기본 true): false 면 2단계를 끈다(순수 법선 판정, pointSizeM 불필요).
 * @returns {Uint8Array}
 */
export function backfaceCull(hierarchy, camera, cones, opts) {
  const marginDeg = opts?.marginDeg ?? DEFAULT_MARGIN_DEG;
  const requireCover = opts?.requireCover ?? true;
  if (typeof requireCover !== 'boolean') throw new Error(`${ERR} requireCover 는 boolean 이어야 함: ${String(requireCover)}`);
  const pointSizeM = opts?.pointSizeM;
  if (pointSizeM !== undefined && (typeof pointSizeM !== 'number' || !Number.isFinite(pointSizeM) || !(pointSizeM > 0))) throw new Error(`${ERR} pointSizeM 은 양의 유한 수여야 함: ${String(pointSizeM)}`);
  if (typeof marginDeg !== 'number' || !Number.isFinite(marginDeg) || marginDeg < 0 || marginDeg >= 90) throw new Error(`${ERR} marginDeg 는 [0, 90) 의 유한 수여야 함: ${String(marginDeg)}`);
  const mc = Math.cos(marginDeg * Math.PI / 180), ms = Math.sin(marginDeg * Math.PI / 180);
  checkHierarchy(hierarchy);
  const { octree } = hierarchy;
  const L = octree.leafCount;
  checkCones(cones, L);
  if (degenerateCamera(camera)) return new Uint8Array(L);
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
  if (pointSizeM === undefined) return new Uint8Array(L).fill(1); // 렌더 지름을 모름 → 덮임 판정 불가 → 전부 남김
  return coverFilter(hierarchy, camera, mask, pointSizeM);
}

// 리프마다 단계 0 점의 딱 맞는 상자(occlusion 판정이 쓰는 상자와 같은 값). 계층마다 한 번.
const tightCache = new WeakMap();
function tightBoxes(h) {
  let tb = tightCache.get(h);
  if (tb) return tb;
  const L = h.octree.leafCount, lv = h.levels[0], pos = lv.positions;
  const mn = new Float32Array(3 * L).fill(Infinity), mx = new Float32Array(3 * L).fill(-Infinity);
  for (let k = 0; k < L; k++) {
    for (let s = lv.leafStart[k]; s < lv.leafStart[k + 1]; s++) {
      for (let d = 0; d < 3; d++) {
        const x = pos[3 * s + d];
        if (x < mn[3 * k + d]) mn[3 * k + d] = x;
        if (x > mx[3 * k + d]) mx[3 * k + d] = x;
      }
    }
  }
  tb = { mn, mx };
  tightCache.set(h, tb);
  return tb;
}

// 리프 k 의 딱 맞는 상자를 투영한 화면 사각형(원판 반경 상한 r = fx·s/(2·zmin) + pad px 만큼 넓힘)을 피라미드 칸 범위로.
// 꼭짓점 하나라도 z ≤ NEAR_M 이면 'near', 점이 없거나 화면 밖이면 null.
function cellRect(camera, tb, k, pointSizeM, pad, size) {
  if (!(tb.mn[3 * k] <= tb.mx[3 * k])) return null;
  const { R, t, K, width: W, height: H } = camera;
  let zmin = Infinity, umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let c = 0; c < 8; c++) {
    const X = c & 1 ? tb.mx[3 * k] : tb.mn[3 * k];
    const Y = c & 2 ? tb.mx[3 * k + 1] : tb.mn[3 * k + 1];
    const Z = c & 4 ? tb.mx[3 * k + 2] : tb.mn[3 * k + 2];
    const x = R[0] * X + R[1] * Y + R[2] * Z + t[0];
    const y = R[3] * X + R[4] * Y + R[5] * Z + t[1];
    const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
    if (!(z > NEAR_M)) return 'near';
    const u = (K.fx * x) / z + K.cx, v = (K.fy * y) / z + K.cy;
    if (z < zmin) zmin = z;
    if (u < umin) umin = u; if (u > umax) umax = u;
    if (v < vmin) vmin = v; if (v > vmax) vmax = v;
  }
  if (!Number.isFinite(umin + umax + vmin + vmax)) return 'near';
  const r = (K.fx * pointSizeM) / (2 * zmin) + pad;
  const i0 = Math.max(0, Math.floor(umin - r - 0.5)), i1 = Math.min(W - 1, Math.floor(umax + r));
  const j0 = Math.max(0, Math.floor(vmin - r - 0.5)), j1 = Math.min(H - 1, Math.floor(vmax + r));
  if (i0 > i1 || j0 > j1) return null;
  return [Math.floor((i0 * size) / W), Math.floor((i1 * size) / W), Math.floor((j0 * size) / H), Math.floor((j1 * size) / H), zmin];
}

// 2단계: 1단계 후보(mask 0) 중 화면 영역이 앞쪽 가림막(mask 1 리프의 단계 0 점)으로 확실히 덮인 것만 0 으로 남긴다.
// 가림막은 후보 사각형이 닿는 칸과 겹칠 수 있는 리프로 제한한다(머리말 '가림막 제한'). 판정할 후보가 없으면 피라미드를 만들지 않는다.
function coverFilter(hierarchy, camera, candidates, pointSizeM) {
  const L = candidates.length;
  const out = new Uint8Array(L).fill(1);
  const size = COVER_PYRAMID_SIZE;
  const tb = tightBoxes(hierarchy);
  // 후보 사각형이 닿는 0 단계 칸(occlusionCull 과 같은 식: 반경 상한 + 1 px)마다, 그 칸에 닿는 후보 zmin 의 최댓값.
  // 'near'·화면 밖 후보는 occlusionCull 이 남기므로 칸이 필요 없다.
  const needZ = new Float64Array(size * size); // 0 = 필요 없음
  let any = false;
  for (let k = 0; k < L; k++) {
    if (candidates[k] !== 0) continue;
    const rc = cellRect(camera, tb, k, pointSizeM, 1, size);
    if (!Array.isArray(rc)) continue;
    any = true;
    for (let b = rc[2]; b <= rc[3]; b++) for (let a = rc[0]; a <= rc[1]; a++) if (rc[4] > needZ[b * size + a]) needZ[b * size + a] = rc[4];
  }
  if (!any) return out;
  // 가림막 리프를 고른다. 리프 점의 깊이는 상자 최소 깊이 zo 이상이고, 칸을 '덮였다'고 판정하려면 점 깊이가 후보 zmin 보다 작아야 한다.
  // 그래서 사각형 안 칸들의 needZ 최댓값보다 zo 가 작을 때만 이 리프가 판정에 영향을 줄 수 있다(Float32 깊이 반올림은 1e-6 상대 여유로 흡수).
  const occ = new Uint8Array(L);
  for (let k = 0; k < L; k++) {
    if (candidates[k] !== 1) continue;
    // 가림막 점 원판이 칠하는 픽셀은 이 사각형(반경 상한 + 1 px 여유) 안이다. near 이면 반경 상한이 없으므로 그대로 쓴다.
    const rc = cellRect(camera, tb, k, pointSizeM, 1, size);
    if (rc === null) continue;
    if (rc === 'near') { occ[k] = 1; continue; }
    const [a0, a1, b0, b1, zo] = rc;
    let m = 0;
    for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) if (needZ[b * size + a] > m) m = needZ[b * size + a];
    if (zo * (1 - 1e-6) < m) occ[k] = 1;
  }
  const pyramid = buildDepthPyramid(hierarchy, camera, { size, pointSizeM, occluderLevel: 0, occluderMask: occ });
  const hidden = occlusionCull(hierarchy, camera, pyramid);
  for (let k = 0; k < L; k++) if (candidates[k] === 0 && hidden[k] === 0) out[k] = 0;
  return out;
}
