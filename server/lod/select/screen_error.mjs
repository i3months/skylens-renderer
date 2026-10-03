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
//   꼭짓점 하나라도 z ≤ 0 이면(상자가 카메라 평면에 닿거나 뒤로 걸침) cMin ≤ 0 → d_eff = 0 → 원본 단계 0(보수적).
// 상자 안에 놓인 길이 e 인 선분은 화면 길이 ≤ ∫ f/(r·cos²α) ≤ f·e/d_eff 이다. 그래서 거리표에 d 대신 d_eff 를 넣으면
//   f·edgeM(l)/d_eff ≤ τ 인 단계 l 의 칸 변(상자 안 부분)은 화면에서 τ px 이하다.
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
    const v = z / Math.sqrt(x * x + y * y + z * z);
    if (v < c) c = v;
  }
  return c;
}

/**
 * 리프 상자의 실효 거리 d_eff = d·cMin² (머리 주석). 0 이면 원본 단계를 써야 한다.
 * @returns {{distM:number, cosMin:number, effDistM:number}}
 */
export function effectiveDistance(camera, C, mn, mx) {
  const distM = boxDistanceM(C, mn, mx);
  const cosMin = minCosToAxis(camera, mn, mx);
  const effDistM = distM > 0 && cosMin > 0 ? distM * cosMin * cosMin : 0;
  return { distM, cosMin, effDistM };
}

/**
 * 카메라 하나에 대한 화면 오차 규칙. 거리표는 f = max(fx, fy) 로 만든다.
 * leaf(mn, mx) 는 리프 상자의 {distM, cosMin, effDistM, level} 을 준다(level = d_eff 로 고른 단계, d_eff = 0 이면 0).
 * @param {{K:{fx:number,fy:number}, R:number[], t:number[]}} camera
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
