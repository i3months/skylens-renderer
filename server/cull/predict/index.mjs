// 시점 예측(T08.5): 이동 방향을 앞당겨 보낸다. 현재 시점과 예측 시점들의 절두체 판정을 OR 로 합친다(보수적, 새 점 없음).
// frustumCull(server/cull/frustum)은 다른 하위 작업의 소유라 여기서는 같은 규칙(boxMayBeVisibleSplat)을 직접 쓴다.
import { boxMayBeVisibleSplat } from '../../lod/select/view_check.mjs';
import { cameraCenter } from '../../lod/select/screen_error.mjs';
import { isDegenerateView, degenerateCamera, assertCameraShape } from '../degenerate/index.mjs';
import { guardHierarchyRead } from '../degenerate/hierarchy_guard.mjs';
import { checkLeafIndexOneToOne } from '../degenerate/leaf_check.mjs';

const ERR = 'cull:';
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function vec3(v, name) {
  if (v === undefined) return [0, 0, 0];
  if (!Array.isArray(v) && !ArrayBuffer.isView(v)) throw new Error(`${ERR} ${name} 는 길이 3 의 배열이어야 함`);
  if (v.length !== 3 || typeof v[0] !== 'number' || typeof v[1] !== 'number' || typeof v[2] !== 'number') throw new Error(`${ERR} ${name} 는 수 3개여야 함`);
  return [v[0], v[1], v[2]];
}

/** 로드리게스: 축 w/|w|, 각 |w|·dt 의 회전 행렬(행 우선). */
function rodrigues(w, dt) {
  const th = Math.hypot(w[0], w[1], w[2]) * dt;
  if (th === 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const n = Math.hypot(w[0], w[1], w[2]);
  const x = w[0] / n, y = w[1] / n, z = w[2] / n;
  const c = Math.cos(th), s = Math.sin(th), k = 1 - c;
  return [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
}

/**
 * dtS 초 뒤의 카메라. 중심 C → C + v·dt. 카메라 축(R 의 행)은 세계 좌표 각속도 ω 로 돌므로 R_new = R·Rotᵀ(ω·dt),
 * t = −R_new·C_new. K·width·height 는 그대로. NaN 입력은 던지지 않고 NaN 이 그대로 퍼진다(퇴화 시점).
 */
export function predictCamera(camera, motion, dtS) {
  if (motion !== undefined && (motion === null || typeof motion !== 'object')) throw new Error(`${ERR} motion 은 객체여야 함`);
  const { velocityMps, angularRadPerS } = motion ?? {};
  assertCameraShape(camera); // 다른 단계와 같은 입구 검사(F-136)
  if (typeof dtS !== 'number' || Number.isNaN(dtS)) throw new Error(`${ERR} dtS 는 수여야 함: ${String(dtS)}`);
  const v = vec3(velocityMps, 'velocityMps');
  const w = vec3(angularRadPerS, 'angularRadPerS');
  const C = cameraCenter(camera);
  const Cn = [C[0] + v[0] * dtS, C[1] + v[1] * dtS, C[2] + v[2] * dtS];
  const Q = rodrigues(w, dtS); // 세계 좌표 회전
  const R = camera.R;
  const Rn = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += R[i * 3 + k] * Q[j * 3 + k]; // (R·Qᵀ)[i][j]
    Rn[i * 3 + j] = s;
  }
  const t = [
    -(Rn[0] * Cn[0] + Rn[1] * Cn[1] + Rn[2] * Cn[2]),
    -(Rn[3] * Cn[0] + Rn[4] * Cn[1] + Rn[5] * Cn[2]),
    -(Rn[6] * Cn[0] + Rn[7] * Cn[1] + Rn[8] * Cn[2]),
  ];
  return { ...camera, R: Rn, t };
}

/** 계층 필드를 읽고 검사한다(getter·Proxy 예외 대상). 할당·수식은 여기서 하지 않는다. */
function readLeaves(h) {
  const o = h?.octree;
  if (!o || !Number.isInteger(o.leafCount) || o.leafCount < 1 || !o.leafIndex || !o.boxMin || !o.boxMax) throw new Error(`${ERR} 계층의 팔진 트리가 올바르지 않음`);
  // frustum/distance/occlusion 과 같이 leafIndex 는 Int32Array 만 허용(F-153). 상자는 Float32Array/Float64Array 만(일반 배열 거부).
  const f = (a) => a instanceof Float32Array || a instanceof Float64Array;
  if (!(o.leafIndex instanceof Int32Array) || !f(o.boxMin) || !f(o.boxMax)) {
    throw new Error(`${ERR} octree 배열 형식 오류: leafIndex=Int32Array, boxMin/boxMax=Float32Array|Float64Array 여야 함`);
  }
  const n = o.leafCount;
  const { leafIndex, boxMin, boxMax } = o;
  const nodeCount = Number.isInteger(o.nodeCount) ? o.nodeCount : leafIndex.length;
  if (nodeCount < 0 || leafIndex.length < nodeCount || boxMin.length < 3 * nodeCount || boxMax.length < 3 * nodeCount) {
    throw new Error(`${ERR} octree 배열 길이가 nodeCount 와 맞지 않음`);
  }
  // 리프 ↔ 노드 일대일, 리프 상자의 ±Infinity 거부(F-150). 중복 k 와 빠진 리프가 (0,0,0) 상자로 남아 거짓 제거되는 것을 막는다.
  checkLeafIndexOneToOne({ leafIndex, boxMin, boxMax, leafCount: n, nodeCount });
  // frustumCull 과 같이 빈 리프(levels[0] 구간이 빈 리프)는 그릴 점이 없으므로 제외한다.
  const ls = h.levels?.[0]?.leafStart;
  if (ls !== undefined && ls !== null && ls.length !== n + 1) throw new Error(`${ERR} levels[0].leafStart 길이가 leafCount+1 이 아님`);
  return { n, leafIndex, boxMin, boxMax, nodeCount, ls };
}

function leafBoxes(h) {
  const { n, leafIndex, boxMin, boxMax, nodeCount, ls } = guardHierarchyRead(() => readLeaves(h)); // 가드는 필드 읽기·검사에만(F-152 ⑦)
  const mn = new Float64Array(3 * n), mx = new Float64Array(3 * n);
  for (let i = 0; i < nodeCount; i++) {
    const k = leafIndex[i];
    if (k < 0) continue;
    for (let a = 0; a < 3; a++) { mn[3 * k + a] = boxMin[3 * i + a]; mx[3 * k + a] = boxMax[3 * i + a]; }
  }
  let empty = null;
  if (ls !== undefined && ls !== null) {
    empty = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (ls[k + 1] === ls[k]) empty[k] = 1;
  }
  return { n, mn, mx, empty };
}

/**
 * pointSizeM(래스터 원판 지름 m)이 있으면 원판이 화면 가장자리에 걸치는 리프도 남긴다. 없으면 좌·우·위·아래로 버리지 않는다(frustumCull 과 같은 규칙).
 * 현재와 예측 시점들(0..horizonS 를 steps 등분, steps+1 개)의 절두체 판정 합집합.
 * 표본 사이의 시각도 놓치지 않도록 표본마다 상자를 '구간 반폭 h = horizonS/(2·steps)' 동안 카메라가 움직일 수 있는 만큼
 * (이동 |v|·h, 회전 |ω|·h × 거리) 부풀려 판정한다. 속도·각속도가 0 이면 부풀림 0 = 현재 시점 판정과 같다.
 * 한계: 예측 표본(tau>0)이 모두 퇴화면 표본 사이는 덮지 않음(horizon 에 대해 비단조 가능).
 */
export function predictiveMask(hierarchy, state, opts) {
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new Error(`${ERR} opts 는 객체여야 함`);
  const { horizonS, steps, pointSizeM } = opts ?? {};
  if (!fin(horizonS) || horizonS < 0) throw new Error(`${ERR} horizonS 는 0 이상의 유한수여야 함: ${String(horizonS)}`);
  if (!Number.isInteger(steps) || steps < 1 || steps > 10000) throw new Error(`${ERR} steps 는 1..10000 의 정수여야 함: ${String(steps)}`);
  if (pointSizeM !== undefined && pointSizeM !== null && !(fin(pointSizeM) && pointSizeM >= 0)) throw new Error(`${ERR} pointSizeM 은 0 이상의 유한수여야 함: ${String(pointSizeM)}`);
  const { n, mn, mx, empty } = leafBoxes(hierarchy); // 필드 읽기의 getter·Proxy 예외는 cull: 오류로(F-148)
  const out = new Uint8Array(n);
  const cam = state?.camera;
  const v = vec3(state?.velocityMps, 'velocityMps'); // 형식 오류는 퇴화 카메라보다 먼저 던진다
  const w = vec3(state?.angularRadPerS, 'angularRadPerS');
  if (degenerateCamera(cam)) return out;
  if (!v.every(fin) || !w.every(fin)) return out; // 퇴화 속도: 빈 마스크
  const speed = Math.hypot(v[0], v[1], v[2]);
  const omega = Math.hypot(w[0], w[1], w[2]);
  const dt = horizonS / steps;
  const h = dt / 2;
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let s = 0; s <= steps; s++) {
    const tau = s * dt;
    const pc = tau === 0 ? cam : predictCamera(cam, { velocityMps: v, angularRadPerS: w }, tau);
    if (isDegenerateView(pc)) continue;
    const C = cameraCenter(pc);
    const moves = speed > 0 || omega > 0;
    for (let k = 0; k < n; k++) {
      if (out[k] || (empty && empty[k])) continue;
      // NaN 좌표 리프는 판정할 수 없으므로 통과(계약: 거짓 제거 0). NaN 꼭짓점은 모든 평면 비교를 거짓으로 만들어 제거되던 곳.
      if (Number.isNaN(mn[3 * k] + mn[3 * k + 1] + mn[3 * k + 2] + mx[3 * k] + mx[3 * k + 1] + mx[3 * k + 2])) { out[k] = 1; continue; }
      let m = 0;
      if (moves) {
        // 상자 꼭짓점까지 최대 거리로 회전에 의한 변위 상한을 잡는다.
        let far;
        const dx = Math.max(Math.abs(mn[3 * k] - C[0]), Math.abs(mx[3 * k] - C[0]));
        const dy = Math.max(Math.abs(mn[3 * k + 1] - C[1]), Math.abs(mx[3 * k + 1] - C[1]));
        const dz = Math.max(Math.abs(mn[3 * k + 2] - C[2]), Math.abs(mx[3 * k + 2] - C[2]));
        far = Math.hypot(dx, dy, dz);
        m = 1.0001 * (speed * h + omega * h * (far + speed * h)) + 1e-9;
        // 부풀림이 유한수로 표현되지 않으면 상한을 잡을 수 없다: 현재 시점(tau=0)은 부풀림 없이 판정하고, 예측 시점은 보수적으로 남긴다(거짓 제거 방지).
        // 알려진 한계(F-138 ⑦): tau=0 은 순수 절두체 판정으로 두므로 예측 표본(tau>0)이 모두 퇴화인 극단 입력(v=1e10·horizon 1e300)에서는 horizon 을 늘려도 비단조 가능하다. 비현실 입력이라 기존 계약(tau=0 은 순수 절두체)을 유지한다.
        if (!Number.isFinite(m)) {
          if (tau === 0) m = 0;
          else { out[k] = 1; continue; }
        }
      }
      for (let a = 0; a < 3; a++) { lo[a] = mn[3 * k + a] - m; hi[a] = mx[3 * k + a] + m; }
      if (boxMayBeVisibleSplat(pc, lo, hi, pointSizeM)) out[k] = 1;
    }
  }
  return out;
}
