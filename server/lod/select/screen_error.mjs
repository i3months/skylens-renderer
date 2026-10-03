// 화면 공간 오차 규칙(F-097 ①③). select·budget·progressive 가 같은 규칙을 쓰도록 여기 한 곳에 둔다.
//
// 근거: 카메라 좌표 p = (x, y, z), z > 0 의 투영 u = fx·x/z + cx, v = fy·y/z + cy. 길이 e 인 작은 변위 δ 의 화면 길이는
//   |J·δ| ≤ ‖J‖·e,  J = [[fx/z, 0, −fx·x/z²], [0, fy/z, −fy·y/z²]].
//   f = max(fx, fy) 로 두면 ‖J‖ ≤ (f/z)·‖[[1,0,−a],[0,1,−b]]‖ (a = x/z, b = y/z) 이고, 그 큰 특이값은 √(1+a²+b²) = 1/cos α
//   (α = 광축과 p 가 이루는 각, r = |p| 이면 cos α = z/r). 따라서 화면 길이 ≤ f·e/(z·cos α) = f·e/(r·cos²α).
//   축 위(α = 0)에서는 기존 f·e/d 와 같고, 가장자리에서는 1/cos²α 배 커진다(화각 90° 모서리 약 5.2배 → 실측 F-097).
// 리프 상자 전체에 대한 보수적 하한: 상자 안 모든 점에서 r ≥ d(카메라 중심~상자 최소 거리), cos α ≥ cMin 이므로
//   r·cos²α ≥ d_eff = d · cMin²,   cMin = 상자 8 꼭짓점의 z/r 최솟값.
//   cMin 이 꼭짓점 최솟값인 이유: {p : α(p) ≤ θ} (θ < 90°) 는 볼록 원뿔이므로 꼭짓점이 모두 그 안이면 상자 전체가 그 안이다.
//   꼭짓점 하나라도 z ≤ 0 이면(상자가 카메라 평면에 닿거나 뒤로 걸침) cMin = 0 이다.
// 상자 안에 놓인 길이 e 인 선분은 화면 길이 ≤ ∫ f/(r·cos²α) ≤ f·e/d_eff 이다. 그래서 거리표에 d 대신 d_eff 를 넣으면
//   f·edgeM(l)/d_eff ≤ τ 인 단계 l 의 칸 변(상자 안 부분)은 화면에서 τ px 이하다.
// 화면 안 부분만 보기(F-104 ②): 화면에 그려지는 점은 시야 사각뿔 V(네 옆면 반공간, z > 0) 안에 있다.
//   P = 상자 ∩ V 는 볼록 다면체다. z 는 일차식이라 P 위 최솟값 z_P 는 P 의 꼭짓점에서, cos α 는 {cos α ≥ θ} 가 볼록 원뿔
//   (준오목)이라 P 위 최솟값 c_P 도 P 의 꼭짓점에서 난다. P 의 모든 점에서 z·cos α ≥ z_P·c_P 이고 화면 길이 ≤ f·e/(z·cos α).
//   또 z = r·cos α ≥ d·c_P 이므로 z_P·c_P ≥ d·c_P² ≥ d·cMin² (P ⊂ 상자) → 상자 전체 규칙보다 항상 거칠거나 같다.
//   P 의 꼭짓점 = 세 평면(상자 면 6·V 옆면 4)의 교점: 상자 꼭짓점(∈ V), 상자 모서리 ∩ V 옆면(∈ V),
//   화면 모서리 광선(이웃한 V 옆면 둘의 교선) ∩ 상자 면, V 옆면 셋 이상의 교점 = 카메라 중심(d > 0 이면 P 밖). 모두 센다.
//   그래서 d_eff = max(d·cMin², z_P·c_P) 이고, 칸 변 중 화면에 그려지는 부분(선분 ∩ V, 한 구간)의 투영 길이 ≤ f·e/d_eff.
//   카메라 평면에 걸친 상자도 카메라 중심이 상자 밖(d > 0)이면 d_eff > 0. 중심이 상자 안(d = 0)이면 여전히 단계 0.
//   화면 밖으로 나간 부분의 투영 길이는 보장하지 않는다(보이지 않으므로 오차가 아니다). P 가 비면(시야 판정이 보수적이라
//   통과한 상자) 상자 전체 규칙을 쓴다. 경계 판정은 여유 있게 받아 후보를 더 넣는 쪽(최솟값이 작아질 뿐)으로 둔다.
// 대가: 가장자리·큰 리프에서 더 고운 단계(점이 더 많음)를 고른다. 화면 중앙 작은 리프는 거의 그대로(cMin ≈ 1).
import { buildDistanceTable, levelForDistance } from '../distance_table/index.mjs';

/** 화면 오차에 쓰는 초점거리(px): 가로·세로 중 큰 쪽(fy > fx 이면 세로가 더 크게 보인다). */
export function screenFocalPx(K) {
  return Math.max(K.fx, K.fy);
}

/** 카메라 중심(세계 좌표). X_c = R·X_w + t 이므로 C = −Rᵀ·t. */
export function cameraCenter({ R, t }) {
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

/** 점 C 와 축 정렬 상자의 최소 거리(안이면 0). */
export function boxDistanceM(C, mn, mx) {
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const g = C[a] < mn[a] ? mn[a] - C[a] : C[a] > mx[a] ? C[a] - mx[a] : 0;
    s += g * g;
  }
  return Math.sqrt(s);
}

/** 상자 8 꼭짓점에서 cos α = z/r 의 최솟값. 꼭짓점이 z ≤ 0 이면 0 이하를 돌려준다. */
export function minCosToAxis({ R, t }, mn, mx) {
  let c = Infinity;
  for (let k = 0; k < 8; k++) {
    const X = k & 1 ? mx[0] : mn[0];
    const Y = k & 2 ? mx[1] : mn[1];
    const Z = k & 4 ? mx[2] : mn[2];
    const x = R[0] * X + R[1] * Y + R[2] * Z + t[0];
    const y = R[3] * X + R[4] * Y + R[5] * Z + t[1];
    const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
    if (!(z > 0)) return 0;
    const v = z / Math.hypot(x, y, z); // √(x²+y²+z²) 는 좌표 1e155 이상에서 넘쳐 0 이 된다(F-104 ①)
    if (v < c) c = v;
  }
  return c;
}

/**
 * 시야 사각뿔 안에서 cos α 의 최솟값 cV = 화면 네 모서리 광선의 cos 최솟값(참고·시험용, 규칙은 visiblePartBound 를 쓴다).
 * width·height·K 가 유한하지 않으면 0.
 */
export function viewMinCos({ K, width, height }) {
  if (!validView(K, width, height)) return 0;
  const { fx, fy, cx, cy } = K;
  const a = Math.max(Math.abs(cx), Math.abs(width - cx)) / fx;
  const b = Math.max(Math.abs(cy), Math.abs(height - cy)) / fy;
  return 1 / Math.hypot(1, a, b);
}

function validView(K, width, height) {
  if (!K || !(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return false;
  const { fx, fy, cx, cy } = K;
  return fx > 0 && fy > 0 && Number.isFinite(fx) && Number.isFinite(fy) && Number.isFinite(cx) && Number.isFinite(cy);
}

const BOX_EDGES = [];
for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) { const x = a ^ b; if (x === 1 || x === 2 || x === 4) BOX_EDGES.push(a, b); }
const REL_TOL = 1e-9; // 경계 판정 여유(넓게 받아 후보를 더 넣으면 최솟값이 작아질 뿐이라 보수적)
const SAFETY = 1 - 1e-12; // 교점 반올림 오차 몫

/**
 * 상자 ∩ 시야 사각뿔 P 의 z 최솟값과 cos α 최솟값(머리 주석 '화면 안 부분'). P 의 꼭짓점을 모두 후보로 센다:
 *   상자 꼭짓점 ∈ V, 상자 모서리 ∩ V 옆면, 화면 모서리 광선 ∩ 상자(들어가는 점). (V 옆면 셋의 교점은 카메라 중심뿐 → d > 0 이면 P 밖.)
 * @returns {{zMinM:number, cosMin:number} | null} P 가 비면 null
 */
export function visiblePartBound(camera, C, mn, mx) {
  const { R, t, K, width: W, height: H } = camera;
  if (!validView(K, W, H)) return null;
  const { fx, fy, cx, cy } = K;
  const P = new Float64Array(24);
  for (let k = 0; k < 8; k++) {
    const X = k & 1 ? mx[0] : mn[0], Y = k & 2 ? mx[1] : mn[1], Z = k & 4 ? mx[2] : mn[2];
    P[3 * k] = R[0] * X + R[1] * Y + R[2] * Z + t[0];
    P[3 * k + 1] = R[3] * X + R[4] * Y + R[5] * Z + t[1];
    P[3 * k + 2] = R[6] * X + R[7] * Y + R[8] * Z + t[2];
  }
  // V 옆면 g_i(p) ≥ 0 (view_check.mjs 와 같은 네 반공간, 교집합은 z ≥ 0 원뿔)
  const g = (i, x, y, z) => (i === 0 ? fx * x + cx * z : i === 1 ? -(fx * x + (cx - W) * z) : i === 2 ? fy * y + cy * z : -(fy * y + (cy - H) * z));
  const inV = (x, y, z) => {
    if (!(z > 0)) return false;
    const tol = REL_TOL * (fx * Math.abs(x) + fy * Math.abs(y) + (Math.abs(cx) + Math.abs(cy) + W + H) * z);
    for (let i = 0; i < 4; i++) if (g(i, x, y, z) < -tol) return false;
    return true;
  };
  let zMin = Infinity, cMin = Infinity, any = false;
  const take = (x, y, z) => {
    any = true;
    if (z < zMin) zMin = z;
    const c = z / Math.hypot(x, y, z);
    if (c < cMin) cMin = c;
  };
  for (let k = 0; k < 8; k++) if (inV(P[3 * k], P[3 * k + 1], P[3 * k + 2])) take(P[3 * k], P[3 * k + 1], P[3 * k + 2]);
  for (let e = 0; e < BOX_EDGES.length; e += 2) {
    const a = 3 * BOX_EDGES[e], b = 3 * BOX_EDGES[e + 1];
    for (let i = 0; i < 4; i++) {
      const ga = g(i, P[a], P[a + 1], P[a + 2]), gb = g(i, P[b], P[b + 1], P[b + 2]);
      if ((ga < 0) === (gb < 0) || ga === gb) continue;
      const s = ga / (ga - gb);
      const x = P[a] + s * (P[b] - P[a]), y = P[a + 1] + s * (P[b + 1] - P[a + 1]), z = P[a + 2] + s * (P[b + 2] - P[a + 2]);
      if (inV(x, y, z)) take(x, y, z);
    }
  }
  // 화면 모서리 광선 p(s) = s·(a, b, 1) (카메라 좌표), 월드 방향 Rᵀ(a, b, 1). 상자(조금 넓힘)와의 들어가는 점.
  for (let q = 0; q < 4; q++) {
    const da = ((q & 1 ? W : 0) - cx) / fx, db = ((q & 2 ? H : 0) - cy) / fy;
    const dir = [R[0] * da + R[3] * db + R[6], R[1] * da + R[4] * db + R[7], R[2] * da + R[5] * db + R[8]];
    let s0 = 0, s1 = Infinity;
    for (let ax = 0; ax < 3 && s0 <= s1; ax++) {
      const pad = REL_TOL * (mx[ax] - mn[ax] + Math.abs(mn[ax]) + Math.abs(mx[ax]));
      const lo = mn[ax] - pad - C[ax], hi = mx[ax] + pad - C[ax];
      if (dir[ax] === 0) { if (lo > 0 || hi < 0) s1 = -1; continue; }
      let ta = lo / dir[ax], tb = hi / dir[ax];
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > s0) s0 = ta;
      if (tb < s1) s1 = tb;
    }
    if (s0 <= s1 && s1 > 0) take(s0 * da, s0 * db, s0);
  }
  return any ? { zMinM: zMin * SAFETY, cosMin: cMin * SAFETY } : null;
}

/**
 * 리프 상자의 실효 거리 d_eff (머리 주석). 0 이면 원본 단계를 써야 한다.
 *   상자 전체: d·cMin².  화면 안 부분 P = 상자 ∩ V 가 있으면: max(d·cMin², z_P·c_P) (z_P·c_P ≥ d·c_P² ≥ d·cMin²).
 * cosMin 은 상자 꼭짓점 값, visible 은 P 의 {zMinM, cosMin}(P 가 비었거나 화면 크기가 없으면 null).
 * @returns {{distM:number, cosMin:number, visible:{zMinM:number,cosMin:number}|null, effDistM:number}}
 */
export function effectiveDistance(camera, C, mn, mx) {
  const distM = boxDistanceM(C, mn, mx);
  const cosMin = minCosToAxis(camera, mn, mx);
  if (!(distM > 0)) return { distM, cosMin, visible: null, effDistM: 0 };
  const visible = visiblePartBound(camera, C, mn, mx);
  let effDistM = cosMin > 0 ? distM * cosMin * cosMin : 0;
  if (visible) effDistM = Math.max(effDistM, visible.zMinM * visible.cosMin);
  return { distM, cosMin, visible, effDistM };
}

/**
 * 카메라 하나에 대한 화면 오차 규칙. 거리표는 f = max(fx, fy) 로 만든다.
 * leaf(mn, mx) 는 리프 상자의 {distM, cosMin, visible, effDistM, level} 을 준다(level = d_eff 로 고른 단계, d_eff = 0 이면 0).
 * @param {{K:{fx:number,fy:number,cx:number,cy:number}, R:number[], t:number[], width:number, height:number}} camera
 * @param {{thresholdPx:number, edge0M:number, levelCount:number}} opts
 */
export function screenErrorRule(camera, { thresholdPx, edge0M, levelCount }) {
  const focalPx = screenFocalPx(camera.K);
  const table = buildDistanceTable({ fx: focalPx, thresholdPx, edge0M, levelCount });
  const C = cameraCenter(camera);
  const levelFor = (effDistM) => (effDistM > 0 ? levelForDistance(table, effDistM) : 0);
  const leaf = (mn, mx) => {
    const e = effectiveDistance(camera, C, mn, mx);
    return { ...e, level: levelFor(e.effDistM) };
  };
  return { focalPx, table, center: C, levelFor, leaf };
}
