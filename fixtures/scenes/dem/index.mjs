// DEM 타일 합성 장면(관제탑용). 새로 작성한 코드이며 외부 출처 없음.
// 높이장 h(x,z) 는 시드로 정한 사인 합(0~100 m)이고, 타일 격자로 uint16 양자화해 낼 수 있다.
// 격자는 원점 중심: x = (i-(tile-1)/2)*cell, z = (j-(tile-1)/2)*cell (x=동, z=−북, y=위).

import { FORMAT_POINT27, makeResult, mulberry32, subSeed, checkCount, normalizeSeed, checkFormat } from '../../../contracts/scenes/index.mjs';

const MIN_H = 0;
const MAX_H = 100;
const LEVELS = 65536;
const NWAVES = 6;

/** 시드로 사인 합 파라미터를 정한다. 진폭 합 = 50 이므로 h 는 항상 [0,100] 이다. */
export function makeParams(seed) {
  const rnd = mulberry32(subSeed(seed >>> 0, 0));
  const raw = [];
  for (let k = 0; k < NWAVES; k++) raw.push(0.3 + rnd() * (k === 0 ? 2 : 1) / (1 + 0.5 * k));
  const sum = raw.reduce((a, b) => a + b, 0);
  const waves = raw.map((r, k) => {
    const wavelength = 600 / (1 + 0.9 * k) * (0.7 + 0.6 * rnd()); // m
    const dir = rnd() * 2 * Math.PI;
    const kk = (2 * Math.PI) / wavelength;
    return { amp: (50 * r) / sum, kx: kk * Math.cos(dir), kz: kk * Math.sin(dir), phase: rnd() * 2 * Math.PI };
  });
  return { base: 50, waves };
}

/** 해석적 높이(m). */
export function heightAt(params, x, z) {
  let h = params.base;
  for (const w of params.waves) h += w.amp * Math.sin(w.kx * x + w.kz * z + w.phase);
  return h;
}

/** 해석적 기울기 [dh/dx, dh/dz]. */
export function gradientAt(params, x, z) {
  let gx = 0, gz = 0;
  for (const w of params.waves) {
    const c = w.amp * Math.cos(w.kx * x + w.kz * z + w.phase);
    gx += c * w.kx; gz += c * w.kz;
  }
  return [gx, gz];
}

function readOpts(options) {
  const opts = options ?? {};
  const tile = opts.tile ?? 129;
  const cell = opts.cell ?? 10;
  if (!Number.isInteger(tile) || tile < 2) throw new Error('dem: tile 은 2 이상의 정수');
  // 유한 범위 검사: cell=Infinity 면 좌표가 비유한이 된다.
  if (!Number.isFinite(cell) || cell <= 0 || cell > 1e5) throw new Error(`dem: cell 은 0 초과 1e5 m 이하의 유한값: ${String(cell)}`);
  const count = checkCount(opts.count, tile * tile);
  if (count !== tile * tile) throw new Error(`dem: count 는 tile² (${tile * tile}) 이어야 함`);
  return { tile, cell, seed: normalizeSeed(opts.seed), format: checkFormat(opts.format) };
}

const gridCoord = (i, tile, cell) => (i - (tile - 1) / 2) * cell;

/** 격자 높이를 uint16 으로 양자화한다(0~100 m → 0..65535). heights[j*tile+i]. */
export function quantizeTile(opts) {
  const { tile, cell, seed } = readOpts(opts);
  const params = makeParams(seed);
  const heights = new Uint16Array(tile * tile);
  for (let j = 0; j < tile; j++) {
    for (let i = 0; i < tile; i++) {
      const h = heightAt(params, gridCoord(i, tile, cell), gridCoord(j, tile, cell));
      const q = Math.round(((h - MIN_H) / (MAX_H - MIN_H)) * (LEVELS - 1));
      heights[j * tile + i] = Math.min(LEVELS - 1, Math.max(0, q));
    }
  }
  return { tile, cell, minH: MIN_H, maxH: MAX_H, heights };
}

/** 칸 (i,j) 의 역양자화 높이(m). */
export function dequantize(t, i, j) {
  return t.minH + (t.heights[j * t.tile + i] / (LEVELS - 1)) * (t.maxH - t.minH);
}

export function generate(options) {
  const opts = options ?? {};
  const { tile, cell, seed, format } = readOpts(opts);
  const params = makeParams(seed);
  const n = tile * tile;
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  const noise = mulberry32(subSeed(seed, 1));
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < tile; j++) {
    for (let i = 0; i < tile; i++) {
      const p = j * tile + i;
      const x = gridCoord(i, tile, cell), z = gridCoord(j, tile, cell);
      const h = heightAt(params, x, z);
      const [gx, gz] = gradientAt(params, x, z);
      const len = Math.hypot(gx, 1, gz);
      positions[3 * p] = x; positions[3 * p + 1] = h; positions[3 * p + 2] = z;
      normals[3 * p] = -gx / len; normals[3 * p + 1] = 1 / len; normals[3 * p + 2] = -gz / len;
      // 높이 음영(저지대 녹색 → 고지대 갈색/흰색) × 체크 무늬 × 잡음
      const t = (h - MIN_H) / (MAX_H - MIN_H);
      const checker = ((i >> 2) + (j >> 2)) & 1 ? 0.88 : 1.0;
      const shade = (0.55 + 0.45 * (normals[3 * p + 1])) * checker * (0.94 + 0.12 * noise());
      const r = 70 + 150 * t, g = 150 - 20 * t + 60 * t * t, b = 60 + 140 * t * t;
      colors[3 * p] = Math.max(0, Math.min(255, Math.round(r * shade)));
      colors[3 * p + 1] = Math.max(0, Math.min(255, Math.round(g * shade)));
      colors[3 * p + 2] = Math.max(0, Math.min(255, Math.round(b * shade)));
      if (positions[3 * p + 1] < minY) minY = positions[3 * p + 1];
      if (positions[3 * p + 1] > maxY) maxY = positions[3 * p + 1];
    }
  }
  const half = ((tile - 1) / 2) * cell;
  const truth = {
    bounds: { min: [-half, minY, -half], max: [half, maxY, half] },
    params,
    quant: { minH: MIN_H, maxH: MAX_H, levels: LEVELS },
  };
  const cloud27 = { format: FORMAT_POINT27, count: n, positions, normals, colors };
  return makeResult('dem', seed, format, cloud27, truth);
}
