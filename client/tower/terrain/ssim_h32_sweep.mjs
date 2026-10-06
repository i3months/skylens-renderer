// [cloud CPU 렌더] 지형 H32 양자화 step 후보 훑기(F-493). ssim_h32.test.mjs 와 같은 절차(8시점 160×90, 기준 = 같은 DEM 의 LOD 0
// f32 메시를 ref_trace 정점 법선 보간으로 그림, 음영 = server 램버트)로 LOD 1~3 양자화 타일의 최소 SSIM 과
// 양자화 안 한 같은 LOD 대비 하락 최대를 step 후보마다 잰다. 시험도 이 파일의 장면 생성·측정 함수를 가져다 쓴다.
// 장면(측정 전에 고정, 측정 뒤 바꾸지 않음):
//   - hill: makeHillDem 시드 1..50 × 잡음 {0, 0.015}, 2 m 셀.
//   - noiseBig: 시드 0..7, ±1 m 화소 해시 잡음, 1 m 셀(bench/tower/lod_bytes.mjs noiseBigDem 의 가운데 4×4 타일).
//   - lowNoise: 시드 1..8, 완만 언덕 + ±0.15 m 화소 잡음, 1 m 셀(b1_measure lowNoiseDem 가운데 4×4 타일, −20 m).
//   - lowNoise012: 시드 1..12, 같은 언덕 + ±0.12 m 화소 잡음, 1 m 셀(b6_rule noiseHalfDem(s, 0.12) 가운데 4×4 타일, −20 m).
//     LOD 간격이 1 보다 커서(LOD 솎기) 양자화와 동시에 잰다. 간격은 출력에 적는다.
// step 후보: 0.25, 0.15, 0.1, 0.075, 0.05, 0.03(m). 양자화는 계약 quantizeHeights → dequantizeHeights(kbase, step, q)(전역 격자).
//   장면마다 LOD 0 기준·f32 영상은 step 과 무관해 한 번만 그리고, 양자화 영상만 step 후보마다 순서대로 그린다(병렬 아님).
// 출력: stdout 에 표(장면군 × step: 최소 SSIM·위치, 하락 최대), stderr 에 진행.
// 실행: node client/tower/terrain/ssim_h32_sweep.mjs [--groups hill,noiseBig,lowNoise,lowNoise012] [--hill-noises 0,0.015] [--hill-seeds a-b] [--json 경로]
// 시간(2026-10-06, 4코어 cloud, 128 장면): hill 장면당 약 2 s, lowNoise012 약 2.3 s, lowNoise 약 7 s, noiseBig 약 8~13 s(29 회 렌더).
//   장면군을 나눠 프로세스 4개(hill 잡음 0 시드 1..32 / hill 잡음 0.015 시드 1..32 / hill 시드 33..50 / noiseBig+lowNoise+lowNoise012)로
//   동시에 돌렸고 가장 긴 프로세스가 약 2 분 47 초. 각 프로세스 안에서 장면·step 은 순서대로다.
//   SSIM 은 결정적이라 동시 실행이 값에 영향을 주지 않는다.
// 결과(2026-10-06, 전역 격자 6e138ea, 전 장면 최소 SSIM / 하락 최대): 0.25 → 0.9489 미달(noiseBig:6) / 0.0511, 0.15 → 0.9627 / 0.0295,
//   0.1 → 0.9642 / 0.0201, 0.075 → 0.9647 / 0.0148, 0.05 → 0.9647 / 0.0111, 0.03 → 0.9648 / 0.0065.
//   모든 장면 >= 0.95 이고 여유 >= 0.01 인 가장 큰 후보는 0.15(여유 0.0127, 최소 lowNoise012:12 LOD 1 tower_high).
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { createTracer } from './ref_trace.mjs';
import { TERRAIN_SSIM_MIN, TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { quantizeHeights, dequantizeHeights } from '../../../contracts/tower_assets/terrain_h32.mjs';
import { lambert as serverLambert } from '../../../server/raster_ref/shade/index.mjs';

export const SWEEP_STEPS = Object.freeze([0.25, 0.15, 0.1, 0.075, 0.05, 0.03]);
export const LODS = Object.freeze([1, 2, 3]);
export const SWEEP_SCENES = Object.freeze({
  hillSeeds: Array.from({ length: 50 }, (_, k) => k + 1),
  hillNoises: [0, 0.015],
  noiseBigSeeds: [0, 1, 2, 3, 4, 5, 6, 7],
  lowNoiseSeeds: [1, 2, 3, 4, 5, 6, 7, 8],
  lowNoise012Seeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
});
export const LOW_NOISE_HALF_M = 0.15; // b1_measure LOW_NOISE_HALF_M 과 같음
export const LOW_NOISE_012_HALF_M = 0.12; // b6_rule LOW_NOISE_012_HALF_M 과 같음

const VTX = { normals: 'vertex' };
function shadeFnDefault() {
  return (normal) => serverLambert(normal, TERRAIN_DEFAULTS.lightDirEnu, TERRAIN_DEFAULTS.baseRgb, { ambient: TERRAIN_DEFAULTS.ambient });
}

function concatMeshes(meshes) {
  let nv = 0, nt = 0;
  for (const m of meshes) { nv += m.positions.length; nt += m.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(nt), tileOfTriangle = new Int32Array(nt / 3);
  let vo = 0, io = 0, to = 0;
  meshes.forEach((m, n) => {
    positions.set(m.positions, vo);
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k] + vo / 3;
    tileOfTriangle.fill(n, to, to + m.indices.length / 3);
    vo += m.positions.length; io += m.indices.length; to += m.indices.length / 3;
  });
  return { positions, indices, tileOfTriangle };
}

/** bench/tower/lod_bytes.mjs hashNoise 와 같은 식. ∈ [−0.5, 0.5]. */
function hashNoise(i, j, seed = 0) {
  let x = ((i + seed * 31) * 73856093) ^ (j * 19349663);
  x = Math.imul(x ^ (x >>> 13), 0x5bd1e995);
  x ^= x >>> 15;
  return ((x >>> 0) % 1001) / 1000 - 0.5;
}

// 1024 m(1 m 셀, 1025²) DEM 의 가운데 4×4 타일(x,y ∈ [−128,128], 257²). 원래 격자 지수 = 잘라낸 지수 + 384.
const CROP_SIDE = 257, CROP_OFF = 384;
function cropGrid(f) {
  const heights = new Float32Array(CROP_SIDE * CROP_SIDE);
  for (let j = 0; j < CROP_SIDE; j++) for (let i = 0; i < CROP_SIDE; i++) heights[j * CROP_SIDE + i] = f(i + CROP_OFF, j + CROP_OFF);
  return { originX: -128, originY: -128, cellM: 1, width: CROP_SIDE, height: CROP_SIDE, heights };
}
/** noiseBigDem(seed) 의 가운데 4×4 타일. */
export const noiseBigCrop = (seed) => cropGrid((i, j) => 2 * hashNoise(i, j, seed));
/** noiseHalfDem(seed, halfM)(halfM 0.15 = lowNoiseDem) 의 가운데 4×4 타일을 −20 m 옮긴 것(f32 저장값에서 뺀다 — b4 cropCenter 순서). */
export const noiseHalfCrop = (seed, halfM) => cropGrid((i, j) => {
  const x = i - 512, y = j - 512;
  const h = Math.fround(20 + 25 * Math.sin(x / 300) * Math.cos(y / 400) + 2 * halfM * hashNoise(i, j, seed));
  return h - 20;
});

/** 시험·훑기 공용 모듈 묶음과 8시점 카메라. */
export async function loadMods() {
  const fx = await import('./fixtures.mjs');
  const idx = await import('./index.mjs');
  const lod = await import('../../../server/terrain/mesh_lod/index.mjs');
  const ssimMod = await import('../../../server/metrics/ssim/index.mjs');
  const mods = { ...fx, ...idx, ...lod, ssim: ssimMod.ssim };
  return { mods, cams: fx.towerViewpoints() };
}

/** 장면 목록(측정 전 고정). groups 로 장면군을 고를 수 있다. 각 항목 { group, label, make }. */
export function sceneList(mods, scenes = SWEEP_SCENES, groups = ['noiseBig', 'lowNoise', 'lowNoise012', 'hill']) {
  const want = new Set(groups), out = [];
  if (want.has('noiseBig')) for (const s of scenes.noiseBigSeeds) out.push({ group: 'noiseBig', label: `noiseBig:${s}`, make: () => noiseBigCrop(s) });
  if (want.has('lowNoise')) for (const s of scenes.lowNoiseSeeds) out.push({ group: 'lowNoise', label: `lowNoise:${s}`, make: () => noiseHalfCrop(s, LOW_NOISE_HALF_M) });
  if (want.has('lowNoise012')) for (const s of scenes.lowNoise012Seeds) out.push({ group: 'lowNoise012', label: `lowNoise012:${s}`, make: () => noiseHalfCrop(s, LOW_NOISE_012_HALF_M) });
  if (want.has('hill')) for (const n of scenes.hillNoises) for (const s of scenes.hillSeeds) out.push({ group: 'hill', label: `hill:${s}/${n}`, make: () => mods.makeHillDem({ seed: s, noiseRatio: n }) });
  return out;
}

/**
 * 장면 하나: LOD 0 기준 영상 → LOD 1~3 마다 f32 타일 8시점 SSIM 과, steps 의 각 step 으로 양자화 왕복한 타일 8시점 SSIM.
 * 반환 { f32[li][v], quant[si][li][v], strides[li], nullTiles[si], maxQErr[si] }.
 */
export function measureScene(mods, cams, dem, steps) {
  const order = [];
  for (let ty = -2; ty < 2; ty++) for (let tx = -2; tx < 2; tx++) order.push([tx, ty]);
  const lodTiles = [0, ...LODS].map((l) => order.map(([tx, ty]) => mods.buildTerrainTile(dem, tx, ty, l)));
  const tracer = createTracer(concatMeshes(lodTiles[0].map((tl) => mods.terrainTileToMesh(tl))), VTX);
  const refs = cams.map((c) => tracer(c, shadeFnDefault()));
  const render = (l, tiles) => {
    const layer = mods.createTerrainLayer();
    if (layer.accept(l, tiles) !== 'first') throw new Error('층 accept 가 first 가 아님');
    return cams.map((c, v) => {
      const out = layer.render(c);
      return mods.ssim(out.color, refs[v].color, out.width, out.height, 3);
    });
  };
  const strides = LODS.map((l) => (mods.terrainLodStride ? mods.terrainLodStride(dem, l) : null));
  const f32 = LODS.map((l) => render(l, lodTiles[l]));
  const quant = [], nullTiles = [], maxQErr = [];
  for (const step of steps) {
    let nul = 0, err = 0;
    quant.push(LODS.map((l) => render(l, lodTiles[l].map((tl) => {
      const r = quantizeHeights(tl.heights, step);
      if (!r) { nul++; return tl; } // 계약: 양자화 불가 타일은 f32 로 보낸다
      const h = dequantizeHeights(r.kbase, r.step, r.q); // 전역 격자 계약(kbase)
      for (let k = 0; k < h.length; k++) err = Math.max(err, Math.abs(h[k] - tl.heights[k]));
      return { ...tl, heights: h };
    }))));
    nullTiles.push(nul); maxQErr.push(err);
  }
  return { f32, quant, strides, nullTiles, maxQErr };
}

/** 장면군 × step 요약: 최소 SSIM(위치)·하락 최대(위치). */
export function summarize(results, steps, cams) {
  const groups = [...new Set(results.map((r) => r.group))];
  const rows = [];
  for (const g of [...groups, 'ALL']) {
    for (let si = 0; si < steps.length; si++) {
      let min = Infinity, minAt = '', drop = -Infinity, dropAt = '';
      for (const r of results) {
        if (g !== 'ALL' && r.group !== g) continue;
        r.quant[si].forEach((v, li) => v.forEach((x, k) => {
          const at = `${r.label} LOD${LODS[li]} ${cams[k].name}`;
          if (!(x >= min)) { min = x; minAt = at; }
          const d = r.f32[li][k] - x;
          if (d > drop) { drop = d; dropAt = at; }
        }));
      }
      rows.push({ group: g, step: steps[si], min, minAt, drop, dropAt, pass: min >= TERRAIN_SSIM_MIN, margin: min - TERRAIN_SSIM_MIN });
    }
  }
  return rows;
}

async function main() {
  const flags = new Map();
  const argv = process.argv.slice(2);
  for (let k = 0; k < argv.length; k += 2) flags.set(argv[k], argv[k + 1]);
  const groups = flags.has('--groups') ? flags.get('--groups').split(',') : undefined;
  const { mods, cams } = await loadMods();
  const scenes = { ...SWEEP_SCENES };
  if (flags.has('--hill-noises')) scenes.hillNoises = flags.get('--hill-noises').split(',').map(Number);
  if (flags.has('--hill-seeds')) { // 'a-b' 범위(프로세스 나누기용, 장면 집합 자체는 바꾸지 않음)
    const [a, b] = flags.get('--hill-seeds').split('-').map(Number);
    scenes.hillSeeds = SWEEP_SCENES.hillSeeds.filter((s) => s >= a && s <= b);
  }
  const list = sceneList(mods, scenes, groups);
  const t0 = Date.now(), results = [];
  for (const [n, sc] of list.entries()) {
    const t = Date.now();
    const m = measureScene(mods, cams, sc.make(), SWEEP_STEPS);
    results.push({ group: sc.group, label: sc.label, ...m });
    process.stderr.write(`[sweep] ${n + 1}/${list.length} ${sc.label} 간격 ${m.strides.join(',')} 불가타일 ${m.nullTiles.join(',')} ${Date.now() - t} ms\n`);
  }
  const ms = Date.now() - t0;
  const rows = summarize(results, SWEEP_STEPS, cams);
  const lines = [`[ssim_h32_sweep] ${list.length} 장면 × LOD 1~3 × 8시점, step ${SWEEP_STEPS.join('/')} m, 합계 ${ms} ms`,
    '장면군 | step(m) | 최소 SSIM | 여유(−0.95) | 최소 위치 | 하락 최대 | 하락 위치'];
  for (const r of rows) lines.push(`${r.group} | ${r.step} | ${r.min.toFixed(4)}${r.pass ? '' : ' 미달'} | ${r.margin.toFixed(4)} | ${r.minAt} | ${r.drop.toFixed(4)} | ${r.dropAt}`);
  const strideSet = [...new Set(results.map((r) => `${r.group}:${r.strides.join(',')}`))];
  lines.push(`LOD1~3 간격(장면군별 서로 다른 값): ${strideSet.join(' ')}`);
  console.log(lines.join('\n'));
  if (flags.has('--json')) writeFileSync(flags.get('--json'), JSON.stringify({ ms, rows, results: results.map(({ group, label, f32, quant, strides }) => ({ group, label, f32, quant, strides })) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
