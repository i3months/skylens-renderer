// T07.8 이웃 시점 점수. renderer_basis §3-1~§3-5 를 그대로 옮긴다.
//   공유 점 S_ij  = 두 카메라 모두에서 깊이 d>0 이고 화면 [0,width)×[0,height) 안에 투영되는 점
//   광선 각 θ(X)  = arccos( (X−C_i)·(X−C_j) / (|X−C_i|·|X−C_j|) ),  C = −Rᵀt
//   각도 점수 w_θ = exp(−(θ−θ₀)²/2σ_s²) (θ<θ₀),  exp(−(θ−θ₀)²/2σ_l²) (θ≥θ₀)
//   축척 s(X)     = (d_j/f_j)/(d_i/f_i),  f = K.fx
//   축척 점수 w_s = 1 (1/band ≤ s ≤ band),  (band/max(s,1/s))² 그 밖
//   합산 점수     = Σ_{X∈S_ij} w_θ(X)·w_s(X)
// 문서 §3-5 의 "공유 점이 화면에 고루 퍼진 정도" 가산 항은 계약에 없으므로 넣지 않는다.
// 입력(카메라, 점, 후보 배열)은 읽기만 하고 바꾸지 않는다.
import { VIEW_SCORE_CONSTANTS } from '../../../contracts/lod/index.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { projectMany } from '../../raster_ref/project/index.mjs';

const ERR = 'lod:';
const DEG = 180 / Math.PI;
const { theta0Deg, sigmaSmallDeg, sigmaLargeDeg, scaleBand } = VIEW_SCORE_CONSTANTS;

// 카메라 검사. raster 계약 오류를 lod 접두로 다시 던진다.
function checkCamera(cam, name) {
  try {
    assertCamera(cam);
  } catch (e) {
    throw new Error(`${ERR} ${name} 카메라가 계약과 다름 (${e.message})`);
  }
}

// 점 배열 검사: 길이 3의 배수 Float32Array, 모든 좌표 유한.
function checkPoints(points) {
  if (!(points instanceof Float32Array) || points.length % 3 !== 0) throw new Error(`${ERR} points 는 길이가 3 의 배수인 Float32Array 여야 함`);
  for (let i = 0; i < points.length; i += 1) {
    if (!Number.isFinite(points[i])) throw new Error(`${ERR} points[${i}] 가 유한하지 않음`);
  }
}

/** 카메라 중심 C = −Rᵀt (세계 좌표, m). */
export function cameraCenter(cam) {
  checkCamera(cam, 'cam');
  const { R, t } = cam;
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

// 두 중심에서 점 X 로 가는 광선 사이 각(도). 검사 없이 내부에서 쓴다.
function angleDeg(ci, cj, x, y, z) {
  const ax = x - ci[0], ay = y - ci[1], az = z - ci[2];
  const bx = x - cj[0], by = y - cj[1], bz = z - cj[2];
  const na = Math.hypot(ax, ay, az);
  const nb = Math.hypot(bx, by, bz);
  // 반올림으로 |cos|>1 이 되는 것을 막는다.
  const c = Math.min(1, Math.max(-1, (ax * bx + ay * by + az * bz) / (na * nb)));
  return Math.acos(c) * DEG;
}

/** 점 X 에서 두 카메라 중심으로 가는 광선 사이 각 θ(도). renderer_basis §3-2. */
export function rayAngleDeg(camI, camJ, xw) {
  const ci = cameraCenter(camI);
  const cj = cameraCenter(camJ);
  const ok = (Array.isArray(xw) || ArrayBuffer.isView(xw)) && xw.length === 3 && Array.from(xw).every((v) => typeof v === 'number' && Number.isFinite(v));
  if (!ok) throw new Error(`${ERR} xw 는 유한한 3-벡터여야 함`);
  const a = Math.hypot(xw[0] - ci[0], xw[1] - ci[1], xw[2] - ci[2]);
  const b = Math.hypot(xw[0] - cj[0], xw[1] - cj[1], xw[2] - cj[2]);
  if (a === 0 || b === 0) throw new Error(`${ERR} xw 가 카메라 중심과 겹쳐 각이 정의되지 않음`);
  return angleDeg(ci, cj, xw[0], xw[1], xw[2]);
}

/** 각도 점수 w_θ (renderer_basis §3-3). thetaDeg 는 0..180 의 유한수. */
export function angleScore(thetaDeg) {
  if (typeof thetaDeg !== 'number' || !Number.isFinite(thetaDeg) || thetaDeg < 0 || thetaDeg > 180) {
    throw new Error(`${ERR} thetaDeg 는 0..180 의 유한수여야 함: ${String(thetaDeg)}`);
  }
  const sigma = thetaDeg < theta0Deg ? sigmaSmallDeg : sigmaLargeDeg;
  const e = thetaDeg - theta0Deg;
  return Math.exp(-(e * e) / (2 * sigma * sigma));
}

/** 축척 점수 w_s (renderer_basis §3-4). s 는 양의 유한수. */
export function scaleScore(s) {
  if (typeof s !== 'number' || !Number.isFinite(s) || !(s > 0)) throw new Error(`${ERR} s 는 양의 유한수여야 함: ${String(s)}`);
  const m = Math.max(s, 1 / s);
  if (m <= scaleBand) return 1;
  const r = scaleBand / m;
  return r * r;
}

// 화면 안: 픽셀 칸 [0,width)×[0,height). 깊이 d>0 일 때만 u,v 가 유효하다.
const inside = (cam, u, v, d) => d > 0 && u >= 0 && u < cam.width && v >= 0 && v < cam.height;

// 검사를 마친 입력으로 점수를 계산한다. refProj 는 기준 카메라 투영(재사용).
function scoreChecked(refCam, candCam, points, refProj, ci) {
  const n = points.length / 3;
  const candProj = projectMany(candCam, points, new Float64Array(points.length));
  const cj = cameraCenter(candCam);
  const fi = refCam.K.fx;
  const fj = candCam.K.fx;
  let sum = 0;
  for (let k = 0; k < n; k += 1) {
    const o = 3 * k;
    const di = refProj[o + 2];
    const dj = candProj[o + 2];
    if (!inside(refCam, refProj[o], refProj[o + 1], di)) continue;
    if (!inside(candCam, candProj[o], candProj[o + 1], dj)) continue;
    const theta = angleDeg(ci, cj, points[o], points[o + 1], points[o + 2]);
    const s = (dj / fj) / (di / fi);
    sum += angleScore(theta) * scaleScore(s);
  }
  return sum;
}

/** 기준 카메라와 후보 카메라의 합산 점수 Σ w_θ·w_s (renderer_basis §3-5). */
export function viewScore(refCam, candCam, points) {
  checkCamera(refCam, 'refCam');
  checkCamera(candCam, 'candCam');
  checkPoints(points);
  const refProj = projectMany(refCam, points, new Float64Array(points.length));
  return scoreChecked(refCam, candCam, points, refProj, cameraCenter(refCam));
}

/**
 * 후보 카메라마다 점수를 매겨 내림차순으로 돌려준다. 동점이면 index 가 작은 쪽이 앞.
 * 후보 배열이 비었거나 배열이 아니면 'lod:' 오류.
 */
export function rankViews(refCam, candCams, points) {
  checkCamera(refCam, 'refCam');
  if (!Array.isArray(candCams) || candCams.length === 0) throw new Error(`${ERR} candCams 는 비어 있지 않은 배열이어야 함`);
  candCams.forEach((c, i) => checkCamera(c, `candCams[${i}]`));
  checkPoints(points);
  const refProj = projectMany(refCam, points, new Float64Array(points.length));
  const ci = cameraCenter(refCam);
  const out = candCams.map((c, index) => ({ index, score: scoreChecked(refCam, c, points, refProj, ci) }));
  out.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return out;
}
