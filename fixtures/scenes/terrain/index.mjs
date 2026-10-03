// 완만한 지형 장면(T05.2). 해석적 높이장 h(x,z) 위에 점을 뿌린다. 새로 작성한 코드.
// h = offset + Σ a_k sin(kx_k x + kz_k z + φ_k). 높이 0~30 m, 최대 경사 15° 이하가 구성상 보장된다
// (|∇h| ≤ Σ a_k |k_k| = SLOPE_BUDGET < tan 15°).
import { mulberry32, subSeed, makeResult, checkCount, normalizeSeed, checkFormat } from '../../../contracts/scenes/index.mjs';
import { FORMAT_POINT27 } from '../../../contracts/points/index.mjs';

export const DEFAULT_COUNT = 200000;
export const HALF_EXTENT = 100; // x,z ∈ [-100, 100]
const NUM_WAVES = 4;
const SLOPE_BUDGET = 0.25; // tan(15°)=0.2679 보다 작게
const MAX_AMP_SUM = 14; // offset 15 ± 14 → 1~29 m

/** 높이장 계수(params)로 높이(m)를 계산한다. */
export function heightAt(params, x, z) {
  let h = params.offset;
  for (const w of params.waves) h += w.a * Math.sin(w.kx * x + w.kz * z + w.phase);
  return h;
}

/** 해석적 기울기 [dh/dx, dh/dz]. */
export function gradientAt(params, x, z) {
  let gx = 0, gz = 0;
  for (const w of params.waves) {
    const c = w.a * Math.cos(w.kx * x + w.kz * z + w.phase);
    gx += c * w.kx;
    gz += c * w.kz;
  }
  return [gx, gz];
}

/** 위쪽(y>0) 단위 법선 (-h_x, 1, -h_z)/|.|. */
export function normalAt(params, x, z) {
  const [gx, gz] = gradientAt(params, x, z);
  const inv = 1 / Math.hypot(gx, 1, gz);
  return [-gx * inv, inv, -gz * inv];
}

/** 시드로 계수를 정한다. 파장 50~200 m, 경사 예산을 파동에 나눠 진폭을 정한다. */
export function makeParams(seed) {
  const rnd = mulberry32(subSeed(seed, 0));
  const raw = [];
  let sum = 0;
  for (let i = 0; i < NUM_WAVES; i++) { const s = 0.5 + rnd(); raw.push(s); sum += s; }
  const waves = [];
  let ampSum = 0;
  for (let i = 0; i < NUM_WAVES; i++) {
    const lambda = 50 + 150 * rnd();
    const theta = 2 * Math.PI * rnd();
    const kmag = (2 * Math.PI) / lambda;
    const a = (SLOPE_BUDGET * raw[i] / sum) / kmag; // a·|k| = 몫
    ampSum += a;
    waves.push({ a, kx: kmag * Math.cos(theta), kz: kmag * Math.sin(theta), phase: 2 * Math.PI * rnd() });
  }
  // 진폭 합이 높이 범위를 넘으면 전체를 줄인다(경사도 함께 줄어 안전).
  const f = ampSum > MAX_AMP_SUM ? MAX_AMP_SUM / ampSum : 1;
  for (const w of waves) w.a *= f;
  return { offset: 15, waves };
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

export function generate(opts = {}) {
  const seed = normalizeSeed(opts.seed);
  const n = checkCount(opts.count, DEFAULT_COUNT);
  const format = checkFormat(opts.format);
  const params = makeParams(seed);
  const rnd = mulberry32(subSeed(seed, 1));
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = (rnd() * 2 - 1) * HALF_EXTENT;
    const z = (rnd() * 2 - 1) * HALF_EXTENT;
    const y = heightAt(params, x, z);
    const nr = normalAt(params, x, z);
    const noise = rnd() - 0.5;
    // 높이 기반 음영(낮을수록 녹색, 높을수록 황갈색) + 4 m 체크 무늬 + 약한 잡음
    const t = Math.max(0, Math.min(1, y / 30));
    const checker = ((Math.floor(x / 4) + Math.floor(z / 4)) & 1) ? 1 : 0.8;
    const k = (0.55 + 0.45 * t) * checker * (1 + 0.08 * noise);
    colors[3 * i] = clamp255(255 * k * (0.35 + 0.5 * t));
    colors[3 * i + 1] = clamp255(255 * k * (0.75 - 0.2 * t));
    colors[3 * i + 2] = clamp255(255 * k * (0.3 + 0.1 * t));
    positions[3 * i] = x; positions[3 * i + 1] = y; positions[3 * i + 2] = z;
    normals[3 * i] = nr[0]; normals[3 * i + 1] = nr[1]; normals[3 * i + 2] = nr[2];
    for (let a = 0; a < 3; a++) {
      const v = positions[3 * i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (n === 0) { min.fill(0); max.fill(0); }
  const cloud27 = { format: FORMAT_POINT27, count: n, positions, normals, colors };
  const truth = {
    bounds: { min, max },
    maxSlopeDeg: Math.atan(params.waves.reduce((s, w) => s + Math.abs(w.a) * Math.hypot(w.kx, w.kz), 0)) * 180 / Math.PI,
    heightAt: { description: 'h(x,z)=offset+Σ a·sin(kx·x+kz·z+phase); 모듈의 heightAt(params,x,z)', params },
  };
  return makeResult('terrain', seed, format, cloud27, truth);
}
