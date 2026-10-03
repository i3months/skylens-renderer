// 합성 장면 depth_noise(T05.6): 깊이 오차 모형에 따른 잡음 주입.
//
// 근거: renderer_basis.md §3-7 "깊이 해상도" — 깊이 d, 기선 b, 초점 f(px) 일 때 1px 시차가 뜻하는 깊이 변화는
//   Δd ≈ d² / (f·b).
// 이 장면은 기울어진 정답 평면 여러 장(깊이 5~80 m)을 카메라 픽셀 (u,v) 에서 역투영한 정답 점군에
// 카메라 깊이축 방향으로 가우시안 잡음 σ(d) = Δd(d) = d²/(f·b) 를 넣는다.
//
// 카메라(OpenCV 규약: x 우, y 아래, z 전방)는 원점에 있고 북쪽을 수평으로 바라본다.
// 내부 파라미터 K 의 기본값은 renderer_basis.md §1-2(960×540, fx 754.32, fy 753.85, cx 480, cy 270)와 같다.
// 카메라 → 씬(ENU: x=동, y=위, z=−북) 변환은 X_s = (x_c, −y_c, −z_c) 이다(회전 diag(1,−1,−1), 이동 0).
//
// 점 하나 만드는 순서:
//   1) 평면 i 위의 점을 고르고 픽셀 (u,v) 로 투영한다. 그 픽셀 광선에서 가장 가까운 평면이 i 이고(가림 없음)
//      깊이가 [5, 80] m 이며 화면 안일 때만 받는다(아니면 다시 뽑는다).
//   2) X_c = d · K⁻¹ [u, v, 1]ᵀ 로 정답 위치를 만들고, d' = d + N(0, σ(d)²) 로 흔든 X_c' = d' · K⁻¹ [u, v, 1]ᵀ 를 점으로 낸다.
//      정규분포는 mulberry32 로 Box–Muller 변환한다. 잡음은 광선을 따라가므로 다시 투영하면 같은 픽셀, 깊이만 d' 이다.
// 표본 뽑기와 잡음은 서로 다른 부분 시드를 써서 noise:false 의 점은 같은 시드의 잡음 점과 같은 픽셀·정답 깊이를 갖는다.

import { mulberry32, subSeed, makeResult } from '../../../contracts/scenes/index.mjs';
import { FORMAT_POINT27 } from '../../../contracts/points/index.mjs';

export const SCENE = 'depth_noise';

/** renderer_basis.md §1-2 의 960px K(카메라 1). */
export const DOC_K = Object.freeze({ fx: 754.32, fy: 753.85, cx: 480, cy: 270, width: 960, height: 540 });
export const DEFAULTS = Object.freeze({ f: DOC_K.fx, b: 0.5, count: 200000 });
/** 정답 깊이 범위(m). */
export const DEPTH_RANGE = Object.freeze([5, 80]);
export const SIGMA_OF_D = 'd^2/(f*b)';

/**
 * 깊이 해상도 Δd = d²/(f·b) (renderer_basis.md §3-7). 이 장면의 잡음 표준편차다.
 * @param {number} d 깊이(m) @param {number} f 초점거리(px) @param {number} b 기선(m) @returns {number} m
 */
export function sigmaDepth(d, f, b) {
  return (d * d) / (f * b);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

/**
 * 정답 평면(카메라 좌표, m). 모두 정면(z 축에 수직)에서 기울어진 사각형이다. 깊이 구간이 겹치며 5~80 m 를 덮는다.
 * 평면은 문서 K 의 화면에서 세로 띠(u 구간)를 하나씩 차지하도록 픽셀 기준점으로 정한다(서로 거의 가리지 않게):
 * 띠 왼쪽 끝 ua 의 깊이 da, 오른쪽 끝 ub 의 깊이 db(가로로 기울기), 세로 축은 tz 만큼 앞뒤로 기울인다.
 * 평면은 쓰는 K 의 픽셀 기준으로 정하므로 f 를 바꾸면 화면 배치·깊이 범위는 같고 미터 기하만 바뀐다. 결과: center, 축 e1·e2(단위, 서로 수직), 반길이 h1·h2,
 * 법선 normal(단위, 카메라 쪽 = 표면 바깥).
 */
export function buildPlanes(K = DOC_K) {
  const spec = [
    { ua: 10, ub: 190, da: 5, db: 14, tz: 0, vh: 200 },
    { ua: 210, ub: 380, da: 26, db: 12, tz: 0.1, vh: 220 },
    { ua: 400, ub: 560, da: 22, db: 45, tz: -0.08, vh: 230 },
    { ua: 580, ub: 760, da: 65, db: 38, tz: 0.1, vh: 220 },
    { ua: 780, ub: 950, da: 55, db: 84, tz: 0, vh: 240 },
  ].map((q) => {
    const A = backproject(q.ua, K.cy, q.da, K);
    const B = backproject(q.ub, K.cy, q.db, K);
    const AB = sub(B, A);
    const center = scale([A[0] + B[0], A[1] + B[1], A[2] + B[2]], 0.5);
    return { center, e1: AB, h1: Math.hypot(...AB) / 2, e2: [0, 1, q.tz], h2: (center[2] * q.vh) / K.fy };
  });
  return spec.map((p, id) => {
    const e1 = unit(p.e1);
    const e2 = unit(sub(p.e2, scale(e1, dot(p.e2, e1)))); // 그람–슈미트
    let n = unit(cross(e1, e2));
    if (dot(n, p.center) > 0) n = scale(n, -1); // 카메라(원점) 쪽을 향하게
    return { id, center: p.center, e1, e2, h1: p.h1, h2: p.h2, normal: n };
  });
}
/** 기본 K(문서 값)의 평면. */
export const PLANES = Object.freeze(buildPlanes());

/**
 * K 를 만든다. f 가 기본값이면 문서 K 그대로, 아니면 fx=f, fy=f·(fy/fx)_문서(종횡비 유지), 주점은 문서 값.
 * @param {number} f @returns {{fx:number, fy:number, cx:number, cy:number, width:number, height:number}}
 */
export function makeK(f) {
  if (f === DOC_K.fx) return { ...DOC_K };
  return { ...DOC_K, fx: f, fy: (f * DOC_K.fy) / DOC_K.fx };
}

/** 카메라 → 씬. @param {number[]} c @returns {number[]} */
export const cameraToScene = (c) => [c[0], -c[1], -c[2]];
/** 씬 → 카메라(같은 변환, 자기 역). @param {number[]} s @returns {number[]} */
export const sceneToCamera = (s) => [s[0], -s[1], -s[2]];

/** 투영: 카메라 좌표 → [u, v, d]. d = X_c.z. */
export function project(Xc, K) {
  return [K.fx * (Xc[0] / Xc[2]) + K.cx, K.fy * (Xc[1] / Xc[2]) + K.cy, Xc[2]];
}

/** 역투영: X_c = d · K⁻¹ [u, v, 1]ᵀ. */
export function backproject(u, v, d, K) {
  return [d * ((u - K.cx) / K.fx), d * ((v - K.cy) / K.fy), d];
}

/**
 * 픽셀 광선의 정답 깊이: 모든 평면과의 교점 가운데 가장 가까운(깊이 > 0) 것. 없으면 null.
 * @param {number} u @param {number} v @param {object} K @param {readonly object[]} [planes]
 * @returns {{d:number, plane:number}|null}
 */
export function trueDepthAt(u, v, K, planes = PLANES) {
  const r = [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1]; // z 성분 1 → 매개변수 = 깊이
  let best = null;
  for (const p of planes) {
    const den = dot(p.normal, r);
    if (den === 0) continue;
    const d = dot(p.normal, p.center) / den;
    if (!(d > 0)) continue;
    const q = sub(scale(r, d), p.center);
    if (Math.abs(dot(q, p.e1)) > p.h1 || Math.abs(dot(q, p.e2)) > p.h2) continue;
    if (best === null || d < best.d) best = { d, plane: p.id };
  }
  return best;
}

/** 평면별 기본색(결정적). */
const BASE = [[200, 80, 60], [70, 160, 90], [60, 110, 200], [210, 180, 60], [160, 80, 190], [120, 120, 120]];

/**
 * @param {{seed?:number, count?:number, format?:1|2, f?:number, b?:number, noise?:boolean}} [opts]
 * @returns {import('../../../contracts/scenes/index.mjs').SceneResult}
 */
export function generate(opts = {}) {
  const seed = (opts.seed ?? 1) >>> 0;
  const count = opts.count ?? DEFAULTS.count;
  const f = opts.f ?? DEFAULTS.f;
  const b = opts.b ?? DEFAULTS.b;
  const noise = opts.noise ?? true;
  if (!Number.isInteger(count) || count < 0) throw new Error('depth_noise: count 는 0 이상 정수');
  if (!(f > 0) || !(b > 0)) throw new Error('depth_noise: f, b 는 양수');
  const K = makeK(f);
  const planes = buildPlanes(K);

  const pick = mulberry32(subSeed(seed, 0));
  const nrand = mulberry32(subSeed(seed, 1));
  let spare = null;
  const gauss = () => {
    // Box–Muller. 1−U 로 log(0) 을 피한다.
    if (spare !== null) { const s = spare; spare = null; return s; }
    const r = Math.sqrt(-2 * Math.log(1 - nrand()));
    const th = 2 * Math.PI * nrand();
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };

  const positions = new Float32Array(3 * count);
  const normals = new Float32Array(3 * count);
  const colors = new Uint8Array(3 * count);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const perPlane = new Array(planes.length).fill(0);
  const [dMin, dMax] = DEPTH_RANGE;

  let i = 0;
  let attempts = 0;
  const maxAttempts = 1000 * count + 1000;
  while (i < count) {
    if (++attempts > maxAttempts) throw new Error('depth_noise: 표본 받기 실패(f 가 너무 큰가?)');
    const p = planes[Math.floor(pick() * planes.length)];
    const s = (2 * pick() - 1) * p.h1;
    const t = (2 * pick() - 1) * p.h2;
    const X = [p.center[0] + s * p.e1[0] + t * p.e2[0], p.center[1] + s * p.e1[1] + t * p.e2[1], p.center[2] + s * p.e1[2] + t * p.e2[2]];
    if (!(X[2] >= dMin && X[2] <= dMax)) continue;
    const [u, v] = project(X, K);
    if (!(u >= 0 && u < K.width && v >= 0 && v < K.height)) continue;
    const hit = trueDepthAt(u, v, K, planes);
    if (hit === null || hit.plane !== p.id || !(hit.d >= dMin && hit.d <= dMax)) continue;

    const d = hit.d;
    const dn = noise ? d + sigmaDepth(d, f, b) * gauss() : d;
    const S = cameraToScene(backproject(u, v, dn, K));
    const N = cameraToScene(p.normal);
    for (let k = 0; k < 3; k++) {
      positions[3 * i + k] = S[k];
      normals[3 * i + k] = N[k];
    }
    for (let k = 0; k < 3; k++) {
      const v32 = positions[3 * i + k];
      if (v32 < min[k]) min[k] = v32;
      if (v32 > max[k]) max[k] = v32;
    }
    // 무늬: 평면 좌표 1 m 체크 + 깊이에 따른 밝기 줄무늬(5 m 주기). 정답 위치(s,t) 기준이라 잡음과 무관하게 결정적.
    const checker = ((Math.floor(s) + Math.floor(t)) & 1) === 0 ? 1 : 0.55;
    const stripe = 0.85 + 0.15 * Math.cos((2 * Math.PI * d) / 5);
    const base = BASE[p.id];
    for (let k = 0; k < 3; k++) colors[3 * i + k] = Math.max(0, Math.min(255, Math.round(base[k] * checker * stripe)));
    perPlane[p.id]++;
    i++;
  }
  if (count === 0) for (let k = 0; k < 3; k++) { min[k] = 0; max[k] = 0; }

  const cloud27 = { format: FORMAT_POINT27, count, positions, normals, colors };
  const truth = {
    bounds: { min, max },
    f,
    b,
    K: { fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy, width: K.width, height: K.height },
    planes: planes.map((p) => ({ id: p.id, center: p.center, e1: p.e1, e2: p.e2, h1: p.h1, h2: p.h2, normal: p.normal })),
    sigmaOfD: SIGMA_OF_D,
    noise,
    depthRange: [...DEPTH_RANGE],
    frame: { camera: 'OpenCV x 우, y 아래, z 전방; 원점; 북쪽 수평 응시', cameraToScene: 'X_s = (x_c, -y_c, -z_c)' },
    perPlane,
  };
  return makeResult(SCENE, seed, opts.format ?? FORMAT_POINT27, cloud27, truth);
}
