// 관제탑 지형 H32 양자화 8시점 SSIM 시험(T15.10e, F-458 확인 기준). 계약 contracts/tower_assets/terrain_h32.mjs 의
// quantizeHeights(step = TERRAIN_H32_STEP_M = 0.05 m) → dequantizeHeights 로 높이를 왕복시킨 LOD 1~3 타일을 층(createTerrainLayer)으로 그려,
// 같은 DEM 의 LOD 0(f32, 양자화 없음 — 계약상 LOD 0 은 늘 비양자화) 기준 영상과 8시점 SSIM 을 잰다.
// 절차는 ssim_views.test.mjs 2부와 같다(8시점 160×90, 기준 = LOD 0 메시를 ref_trace 정점 법선 보간으로 그림, 음영 = server 램버트).
//   ssim_views.test.mjs 는 도우미를 내보내지 않아 concatMeshes·음영 함수를 같은 식으로 옮겨 적었다.
// 장면(결정 0056 은 noiseBig 시드 0 하나만 쟀다 → 시드 여러 개):
//   - hill: makeHillDem 시드 1..12 × 잡음 {0, 0.015}, 2 m 셀(ssim_views 의 24 장면 그대로).
//   - noiseBig: 시드 0..3, ±1 m 화소 해시 잡음, 1 m 셀. bench/tower/lod_bytes.mjs noiseBigDem(1024 m) 의 가운데 4×4 타일과 같은 값.
//   - lowNoise: 시드 1..3, 완만 언덕 + ±0.15 m 화소 잡음, 1 m 셀. bench/tower/terrain_options/b1_measure.mjs lowNoiseDem 의 가운데 4×4 타일을
//     −20 m 옮긴 것(b4_measure 의 완만 DEM 처리와 같음: 눈 높이 17 m 시점 아래로 내림).
//   bench 파일은 시험이 가져오지 않는다(클라이언트 시험 → bench 의존을 피함). 같은 식을 아래에 옮겼다.
// 판정:
//   (1) 모든 장면·LOD 1~3·8시점 양자화 SSIM >= TERRAIN_SSIM_MIN(0.95, 계약). 낮추지 않는다.
//   (2) 같은 장면·LOD·시점의 양자화 안 한 영상 대비 SSIM 하락량의 장면군별 최댓값 <= DROP_MAX(측정 후 정한 상한, 아래 주석).
// 참고: noiseBig·lowNoise 는 화소 잡음 때문에 LOD 1~3 간격이 LOD 0 과 같아(f32 SSIM 1.0000) 양자화 효과만 잰다. hill 은 LOD 간격 + 양자화를 함께 잰다.
// 측정(2026-10-06, step 0.05, 31 장면): 양자화 최소 SSIM 0.9555(hill 시드 10 잡음 0 LOD 2 시점 4 low_close_box), 장면 계산 합계 약 29 s.
// 변이 확인(2026-10-06, 사본에서 STEP_M 을 0.5 로 바꿔 실행): (1) 실패(최소 0.8495, lowNoise 시드 1 LOD 1 tower_high),
//   (2) 실패(하락 최대 noiseBig 0.1034 · lowNoise 0.1505 · hill 0.1001). 전제·시간 시험은 통과.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTracer } from './ref_trace.mjs';
import { TERRAIN_SSIM_MIN, TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { TERRAIN_H32_STEP_M, quantizeHeights, dequantizeHeights } from '../../../contracts/tower_assets/terrain_h32.mjs';
import { lambert as serverLambert } from '../../../server/raster_ref/shade/index.mjs';

// ---- 미리 정한 값 ----
const STEP_M = TERRAIN_H32_STEP_M; // 계약 step(0.05 m). 변이 확인 때 이 줄을 0.5 로 바꾼다.
const VIEWS = 8;
const LODS = [1, 2, 3];
const HILL_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const HILL_NOISES = [0, 0.015];
const NOISE_BIG_SEEDS = [0, 1, 2, 3];
const LOW_NOISE_SEEDS = [1, 2, 3];
const LOW_NOISE_HALF_M = 0.15; // b1_measure LOW_NOISE_HALF_M 과 같음
const RUN_MS_MAX = 60000; // 시험 전체(장면 계산) 시간 상한

// ---- 측정 후 정한 값 ----
// 양자화 안 한 영상 대비 SSIM 하락량 상한(장면군별, 8시점·LOD 1~3·장면 최댓값).
// 측정(2026-10-06, step 0.05): hill 0.0365(시드 10 잡음 0 LOD 2·3), noiseBig 0.0090(시드 1·LOD 1~3 같음), lowNoise 0.0183(시드 3).
// 상한 = 측정 최댓값 × 1.5 를 소수 셋째 자리로 올림. 1.5 의 근거: 하락량은 step 에 거의 비례한다(noiseBig 시드 0: step 0.05 → 0.0076,
//   step 0.5 → 0.0973, 약 13배). 곧 상한은 'step 이 약 1.5 배(≈0.075 m)로 굵어진 것과 같은 하락' 까지만 허용하고, 그 아래의
//   부동소수·플랫폼 차와 상류 코드의 작은 변화는 흡수한다. step 0.5 의 하락(hill 최대 0.1001, noiseBig 최대 0.1034, lowNoise 최대 0.1505)과는 멀다.
// 주의: 계약 주석 '결정 0056 측정: step ≤ 0.05 m 에서 SSIM 하락 ≤ 0.0076' 은 noiseBig 시드 0 한 장면 값이다. hill(2 m 셀, 완만 언덕)에서는
//   같은 step 에서 하락이 최대 0.0365 로 약 5배 크다(완만한 면에서 계단 높이가 정점 법선을 흔듦). 그래도 SSIM 최소는 0.9555 로 0.95 이상이다.
const DROP_MAX = Object.freeze({ hill: 0.055, noiseBig: 0.014, lowNoise: 0.028 });

// ---- 도우미(ssim_views.test.mjs 와 같은 식) ----
function shadeFnDefault() {
  return (normal) => serverLambert(normal, TERRAIN_DEFAULTS.lightDirEnu, TERRAIN_DEFAULTS.baseRgb, { ambient: TERRAIN_DEFAULTS.ambient });
}
const VTX = { normals: 'vertex' };

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
const noiseBigCrop = (seed) => cropGrid((i, j) => 2 * hashNoise(i, j, seed));
/** lowNoiseDem(seed) 의 가운데 4×4 타일을 −20 m 옮긴 것(f32 로 저장된 원래 값에서 뺀다 — b4 cropCenter 와 같은 순서). */
const lowNoiseCrop = (seed) => cropGrid((i, j) => {
  const x = i - 512, y = j - 512;
  const h = Math.fround(20 + 25 * Math.sin(x / 300) * Math.cos(y / 400) + 2 * LOW_NOISE_HALF_M * hashNoise(i, j, seed));
  return h - 20;
});

describe(`지형 H32 양자화(step ${STEP_M} m) 8시점 SSIM: LOD 1~3 양자화 타일 대 LOD 0 기준`, () => {
  let mods, cams, scenes, runMs;

  // 장면 하나: LOD 0 기준 영상 → LOD 1~3 마다 f32 타일·양자화 왕복 타일 8시점 SSIM.
  function runScene(group, label, dem) {
    const order = [];
    for (let ty = -2; ty < 2; ty++) for (let tx = -2; tx < 2; tx++) order.push([tx, ty]);
    const lodTiles = [0, ...LODS].map((l) => order.map(([tx, ty]) => mods.buildTerrainTile(dem, tx, ty, l)));
    const tracer = createTracer(concatMeshes(lodTiles[0].map((tl) => mods.terrainTileToMesh(tl))), VTX);
    const refs = cams.map((c) => tracer(c, shadeFnDefault()));
    const render = (l, tiles) => {
      const layer = mods.createTerrainLayer();
      assert.equal(layer.accept(l, tiles), 'first');
      return cams.map((c, v) => {
        const out = layer.render(c);
        return mods.ssim(out.color, refs[v].color, out.width, out.height, 3);
      });
    };
    const f32 = [], quant = [];
    let nullTiles = 0, maxQErr = 0;
    for (const l of LODS) {
      const tiles = lodTiles[l];
      const qTiles = tiles.map((tl) => {
        const r = quantizeHeights(tl.heights, STEP_M);
        if (!r) { nullTiles++; return tl; } // 계약: 양자화 불가 타일은 f32 로 보낸다
        const h = dequantizeHeights(r.base, r.step, r.q);
        for (let k = 0; k < h.length; k++) maxQErr = Math.max(maxQErr, Math.abs(h[k] - tl.heights[k]));
        return { ...tl, heights: h };
      });
      f32.push(render(l, tiles));
      quant.push(render(l, qTiles));
    }
    return { group, label, f32, quant, nullTiles, maxQErr };
  }

  before(async () => {
    const fx = await import('./fixtures.mjs');
    const idx = await import('./index.mjs');
    const lod = await import('../../../server/terrain/mesh_lod/index.mjs');
    const ssimMod = await import('../../../server/metrics/ssim/index.mjs');
    mods = { ...fx, ...idx, ...lod, ssim: ssimMod.ssim };
    cams = fx.towerViewpoints();
    assert.equal(cams.length, VIEWS);
    const t0 = Date.now();
    scenes = [];
    for (const s of NOISE_BIG_SEEDS) scenes.push(runScene('noiseBig', `noiseBig:${s}`, noiseBigCrop(s)));
    for (const s of LOW_NOISE_SEEDS) scenes.push(runScene('lowNoise', `lowNoise:${s}`, lowNoiseCrop(s)));
    for (const n of HILL_NOISES) for (const s of HILL_SEEDS) scenes.push(runScene('hill', `hill:${s}/${n}`, fx.makeHillDem({ seed: s, noiseRatio: n })));
    runMs = Date.now() - t0;
    const rows = scenes.map((sc) => `  ${sc.label.padEnd(14)} LOD1..3 양자화 최소 ${sc.quant.map((v) => Math.min(...v).toFixed(4)).join(' ')}`
      + ` | 하락 최대 ${sc.quant.map((v, l) => Math.max(...v.map((x, k) => sc.f32[l][k] - x)).toFixed(4)).join(' ')}`);
    console.log(`[ssim_h32] step ${STEP_M} m, ${scenes.length} 장면 × LOD 1~3 × 8시점 (합계 ${runMs} ms)\n${rows.join('\n')}`);
  });

  test('전제: 모든 LOD 1~3 타일이 양자화되고 복원 오차가 step/2 (+ f32 반올림) 이하다', () => {
    for (const sc of scenes) {
      assert.equal(sc.nullTiles, 0, `${sc.label}: 양자화 불가 타일 ${sc.nullTiles}(시험이 f32 를 재게 됨)`);
      assert.ok(sc.maxQErr > 0, `${sc.label}: 복원 오차 0(양자화가 실제로 일어나지 않음)`);
      assert.ok(sc.maxQErr <= STEP_M / 2 + 1e-5, `${sc.label}: 복원 오차 ${sc.maxQErr} > step/2`);
    }
  });

  test(`(1) 양자화 LOD 1~3 대 LOD 0 기준: 모든 장면·8시점 최소 SSIM >= ${TERRAIN_SSIM_MIN}`, () => {
    const bad = [];
    let min = Infinity, where = '';
    for (const sc of scenes) {
      sc.quant.forEach((v, li) => v.forEach((x, k) => {
        if (x < min) { min = x; where = `${sc.label} LOD ${LODS[li]} 시점 ${k}(${cams[k].name})`; }
        if (!(x >= TERRAIN_SSIM_MIN)) bad.push(`${sc.label} LOD ${LODS[li]} 시점 ${k}: ${x.toFixed(4)}`);
      }));
    }
    console.log(`[ssim_h32] 양자화 최소 SSIM ${min.toFixed(4)} (${where})`);
    assert.deepEqual(bad, [], `양자화 타일이 ${TERRAIN_SSIM_MIN} 미달`);
  });

  test('(2) 양자화 안 한 같은 장면 대비 SSIM 하락량이 장면군별 상한 이하다', () => {
    const worst = {};
    for (const sc of scenes) {
      sc.quant.forEach((v, li) => v.forEach((x, k) => {
        const d = sc.f32[li][k] - x;
        if (!worst[sc.group] || d > worst[sc.group].d) worst[sc.group] = { d, at: `${sc.label} LOD ${LODS[li]} 시점 ${k}` };
      }));
    }
    console.log(`[ssim_h32] 하락 최대: ${Object.entries(worst).map(([g, w]) => `${g} ${w.d.toFixed(4)}(${w.at}, 상한 ${DROP_MAX[g]})`).join(' | ')}`);
    assert.deepEqual(Object.keys(worst).sort(), Object.keys(DROP_MAX).sort());
    for (const [g, w] of Object.entries(worst)) assert.ok(w.d <= DROP_MAX[g], `${g} 하락 ${w.d.toFixed(4)} > 상한 ${DROP_MAX[g]} (${w.at})`);
  });

  test(`시험 시간: 장면 계산 합계 < ${RUN_MS_MAX} ms`, () => {
    assert.ok(runMs < RUN_MS_MAX, `${runMs} ms`);
  });
});
