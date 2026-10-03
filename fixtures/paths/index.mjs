// 카메라 경로 생성기: 드론 추적(원형 비행)·자유 조작(Catmull-Rom 웨이포인트).
// 좌표는 GL 규약·ENU m(x=동, y=위, z=-북), 필드명은 fixtures/viewpoints/synthetic.json 과 같다.
// 경로는 점군이 아니므로 SceneResult 를 쓰지 않는다. 난수는 contracts/scenes 의 mulberry32·subSeed 만 쓴다.
import { mulberry32, subSeed, normalizeSeed } from '../../contracts/scenes/index.mjs';

const UP = [0, 1, 0];
const TAU = Math.PI * 2;
const PITCH_MAX = (30 * Math.PI) / 180; // freePath 시선 pitch 상한(자름)
const FPS_MIN = 1e-3; // 이보다 작으면 t=i/fps 가 비현실적으로 커진다(1e-320 은 Infinity 가 됨)
const FRAMES_MAX = 1e6; // 메모리 보호용 프레임 수 상한

const fail = (msg) => { throw new Error(`paths: ${msg}`); };
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
function checkFrames(frames) {
  if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 0) fail(`frames 는 0 이상의 정수여야 함: ${String(frames)}`);
  if (frames > FRAMES_MAX) fail(`frames 는 ${FRAMES_MAX} 이하여야 함: ${String(frames)}`);
}
function checkFps(fps) {
  if (!isFin(fps) || !(fps > 0)) fail(`fps 는 양의 유한수여야 함: ${String(fps)}`);
  if (fps < FPS_MIN) fail(`fps 는 ${FPS_MIN} 이상이어야 함: ${String(fps)}`);
}
// 결과의 모든 수가 유한한지 검사한다(극단 입력이 Infinity·NaN 으로 새는 것을 막는다).
function checkResult(res) {
  for (const f of res.frames) {
    if (!isFin(f.t) || !f.eye.every(isFin) || !f.target.every(isFin)) fail('결과에 유한하지 않은 값이 생김(입력이 너무 큼)');
  }
  return res;
}
function checkVec3(v, name) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isFin)) fail(`${name} 는 유한한 수 3개의 배열이어야 함: ${String(v)}`);
}
const round = (v) => Math.round(v * 1e6) / 1e6; // 직렬화 안정화(위치값만; t 는 정확히 유지)

/**
 * 드론 추적 경로: center 둘레 원형 비행, 항상 center 를 바라본다.
 * 지터는 시드별 위상의 저주파 사인 합이며 반경·고도·접선 방향 각각 최대 1.5 m(< 2 m).
 */
export function dronePath(opts) {
  let { seed, frames = 300, fps = 30, center = [0, 0, 0], radius = 60, altitude = 40 } = opts ?? {};
  seed = normalizeSeed(seed);
  checkFrames(frames); checkFps(fps); checkVec3(center, 'center');
  if (!isFin(radius) || !isFin(altitude)) fail('radius·altitude 는 유한수여야 함');
  const rnd = mulberry32(subSeed(seed, 1));
  const ph = Array.from({ length: 6 }, () => rnd() * TAU);
  const fr = Array.from({ length: 3 }, () => 0.5 + rnd() * 1.5); // 한 바퀴당 진동 수
  const startAngle = rnd() * TAU;
  const out = [];
  for (let i = 0; i < frames; i++) {
    const a = startAngle + (TAU * i) / frames;
    const u = i / frames;
    const jr = 1.5 * (0.6 * Math.sin(TAU * fr[0] * u + ph[0]) + 0.4 * Math.sin(TAU * 3 * u + ph[1]));
    const jt = 1.5 * (0.6 * Math.sin(TAU * fr[1] * u + ph[2]) + 0.4 * Math.sin(TAU * 4 * u + ph[3]));
    const jy = 1.5 * (0.6 * Math.sin(TAU * fr[2] * u + ph[4]) + 0.4 * Math.sin(TAU * 2 * u + ph[5]));
    const r = radius + jr;
    const cx = Math.cos(a), cz = Math.sin(a);
    const eye = [
      center[0] + r * cx - jt * cz,
      center[1] + altitude + jy,
      center[2] + r * cz + jt * cx,
    ].map(round);
    out.push({ t: i / fps, eye, target: [...center], up: [...UP] });
  }
  return checkResult({ fps, frames: out });
}

// 균일 Catmull-Rom (닫힌 루프) 한 점. p0..p3 는 스칼라 또는 배열.
function cr(p0, p1, p2, p3, s) {
  const s2 = s * s, s3 = s2 * s;
  return 0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (-p0 + 3 * p1 - 3 * p2 + p3) * s3);
}

function loopAt(pts, u) { // u ∈ [0, n) 루프 매개변수; 각 점은 숫자 배열
  const n = pts.length;
  const k = Math.floor(u), s = u - k;
  const g = (j) => pts[((k + j) % n + n) % n];
  const d = pts[0].length;
  const r = new Array(d);
  for (let c = 0; c < d; c++) r[c] = cr(g(-1)[c], g(0)[c], g(1)[c], g(2)[c], s);
  return r;
}

/**
 * 자유 조작 경로: 시드로 정한 웨이포인트를 Catmull-Rom 으로 잇는 닫힌 루프를 등속(10 m/s)으로 이동.
 * 시선은 yaw·pitch 웨이포인트(역시 Catmull-Rom)로 정해 각속도를 억제한다.
 * Catmull-Rom 오버슈트(웨이포인트 ±30° 에서 최대 약 36.6°)가 있으므로 pitch 는 ±30° 로 잘라 상한을 보장한다.
 * bounds: {min:[x,y,z], max:[x,y,z]}. 기본은 flat_boxes 장면 위 공중.
 */
export function freePath(opts) {
  let { seed, frames = 600, fps = 30, bounds } = opts ?? {};
  seed = normalizeSeed(seed);
  checkFrames(frames); checkFps(fps);
  const b = bounds === undefined ? { min: [-90, 20, -90], max: [90, 90, 90] } : bounds;
  if (b === null || typeof b !== 'object') fail('bounds 는 {min, max} 객체여야 함');
  checkVec3(b.min, 'bounds.min'); checkVec3(b.max, 'bounds.max');
  for (let c = 0; c < 3; c++) {
    if (!(b.min[c] < b.max[c])) fail(`bounds.min < bounds.max 여야 함(축 ${c})`);
    if (!isFin(b.max[c] - b.min[c])) fail(`bounds 폭이 너무 큼(축 ${c})`);
  }
  const rnd = mulberry32(subSeed(seed, 2));
  const N = 8;
  const speed = 10; // m/s (상한 15)
  const way = Array.from({ length: N }, () => [0, 1, 2].map((c) => b.min[c] + rnd() * (b.max[c] - b.min[c])));

  // 호장 재매개화: 구간당 200 표본으로 누적 길이 표를 만든다.
  const M = 200 * N;
  const us = new Float64Array(M + 1), ls = new Float64Array(M + 1);
  let prev = loopAt(way, 0);
  for (let i = 1; i <= M; i++) {
    const u = (i / M) * N;
    const p = loopAt(way, u);
    us[i] = u;
    ls[i] = ls[i - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev = p;
  }
  const total = ls[M];
  const uAt = (len) => {
    len = ((len % total) + total) % total;
    let lo = 0, hi = M;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ls[m] <= len) lo = m; else hi = m; }
    const f = (len - ls[lo]) / (ls[hi] - ls[lo] || 1);
    return us[lo] + f * (us[hi] - us[lo]);
  };

  // 시선: yaw 는 웨이포인트 간 최대 ±50° 변화, 구간 시간은 경로 한 바퀴를 N 등분.
  const lookN = 8;
  const yawW = [];
  let yaw = rnd() * TAU;
  for (let i = 0; i < lookN; i++) { yawW.push(yaw); yaw += (rnd() * 2 - 1) * (50 * Math.PI) / 180; }
  const look = yawW.map((y) => [y, ((rnd() * 2 - 1) * 30 * Math.PI) / 180]);
  // 루프가 닫히도록 yaw 를 360° 배수로 되돌리지 않고, 시간 매개로 열린 곡선처럼 쓴다(끝점 복제).
  const lookCurve = (v) => { // v ∈ [0, lookN-1]
    const k = Math.min(Math.floor(v), lookN - 2), s = v - k;
    const g = (j) => look[Math.max(0, Math.min(lookN - 1, k + j))];
    return [0, 1].map((c) => cr(g(-1)[c], g(0)[c], g(1)[c], g(2)[c], s));
  };
  const duration = Math.max(frames - 1, 1) / fps;
  const out = [];
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    const p = loopAt(way, uAt(speed * t)).map((v, c) => Math.min(b.max[c], Math.max(b.min[c], v)));
    const [yw, ptRaw] = lookCurve(((lookN - 1) * t) / duration);
    const pt = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, ptRaw));
    const d = [Math.cos(pt) * Math.sin(yw), Math.sin(pt), -Math.cos(pt) * Math.cos(yw)];
    const eye = p.map(round);
    out.push({ t, eye, target: eye.map((v, c) => round(v + 50 * d[c])), up: [...UP] });
  }
  return checkResult({ fps, frames: out });
}
