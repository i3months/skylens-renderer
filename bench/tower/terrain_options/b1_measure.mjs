// [cloud] 합성 DEM 측정. T15.10b-B1: F-458 비교안 (i) 현행 상한표 [0,0.5,1,1] 대 (ii) 옛 상한표 [0,0.5,1,2].
// 같은 DEM 집합에서 두 안의 LOD0~3 raw 바이트(메시 형식·높이만 형식)와 8시점 최소 SSIM 을 잰다. 판정 기준을 새로 만들지 않고
// 미리 정해진 값(SSIM 0.95 = contracts/controlview TERRAIN_SSIM_MIN, 초기 15 MB = bench/tower_assets INITIAL_LIMIT_BYTES)에 대한
// 통과 여부만 표시한다. 두 값은 낮추지 않는다.
//
// DEM 집합(측정 전에 정함, 모두 bench/tower/lod_bytes.mjs 와 같은 1024 m·1 m 셀·64 m 타일 256 장 격자):
//   - smooth: lod_bytes.mjs smoothDem() 그대로(20 + 25·sin(x/300)·cos(y/400)).
//   - noiseBig:s (s = 1..12): lod_bytes.mjs noiseBigDem(s) 그대로(±1 m 화소 해시 잡음, 언덕 없음).
//   - lowNoise:s (s = 1..12): smooth + 0.3·hashNoise(i,j,s) = ±0.15 m 화소 잡음.
//     ±0.15 m 는 ssim_views 시험의 잡음 진폭(진폭 10 m × 0.015)과 같은 값이다(셀은 1 m, ssim_views 는 2 m).
//     참고: 이 촬영 조건의 Δd(renderer_basis §3-7 표, d = 45.3 m·1위 이웃 기선 8.26 m·1 px 시차)는 0.33 m 다. 합성 DEM 에는
//     촬영 조건이 없으므로 판정 문턱으로 쓰지 않는다(결정 0056).
//     (noiseBig 의 ±1 m 는 F-458 이 'Δd 규모' 라 부른 장면이다.)
//
// 바이트(lod_bytes.mjs 와 같은 정의, raw 만): 256 타일 합. 간격이 DEM 전역 하나라 타일마다 cells 가 같다.
//   메시 형식 = 조각 프레임 머리(PIECE_FRAME_OVERHEAD_BYTES) + 메시 머리 16 B + f32 xyz·cells² + u32 인덱스·6(cells−1)²
//   높이만 형식 = 조각 프레임 머리 + 16 B + f32 높이·cells²
//   현행표 (i) 에서는 smooth 에 대해 lod_bytes.mjs measureLodBytes 와 바이트가 같은지 대조한다(--no-check 로 끔).
//
// SSIM(client/tower/terrain/ssim_views.test.mjs 2부 절차): 기준 영상 = 같은 DEM 의 LOD 0 메시를 ref_trace(정점 법선, 서버 램버트)로,
//   대상 = createTerrainLayer 에 LOD k 타일 묶음을 accept 해 render. 시점 = fixtures towerViewpoints() 8개(160×90, 눈 높이 17 m 올림 포함).
//   SSIM = server/metrics/ssim ssimDetailed 의 전체 창 평균(판정용), 채움 창만 값(ssimFilled)은 참고로 함께 낸다.
//   ssim_views 와 다른 점(이 스크립트의 가정):
//   ① 그리는 범위는 1024 m DEM 의 가운데 4×4 타일(tx,ty ∈ −2..1, ENU x,y ∈ [−128,128))이다 — ssim_views 장면과 같은 창.
//      간격은 1024 m DEM 전체(256 타일)로 정하므로 바이트 측정과 같은 메시다.
//   ② 셀이 1 m(ssim_views 는 2 m)라 LOD 0 삼각형이 4 배다.
//   ③ 수직 이동: towerViewpoints 는 지형 최고 15 m(눈 17 m − 2 m)를 전제한다. 창 안 LOD 0 최고 높이가 15 m 를 넘으면
//      정수 m 오프셋 ceil(max − 15) 만큼 기준·대상 메시를 똑같이 아래로 옮긴다(강체 이동 = 카메라를 그만큼 올린 것과 같다,
//      법선·음영 불변). 정수라 Float32 높이의 차가 정확히 표현된다. smooth·lowNoise 만 해당하고 noiseBig 은 0 이다.
//   ④ 같은 DEM 에서 간격이 같은 LOD 는 메시가 같으므로 SSIM 을 한 번만 재서 공유한다(결정적 계산).
//
// 실행: node bench/tower/terrain_options/b1_measure.mjs [--json 경로] [--only smooth,noiseBig:1,...] [--no-check]
//   표를 표준출력에 찍고, --json 이 있으면 전체 결과를 그 경로에 JSON 으로 쓴다.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { smoothDem, noiseBigDem, measureLodBytes } from '../lod_bytes.mjs';
import { INITIAL_LIMIT_BYTES } from '../../tower_assets/index.mjs';
import { PIECE_FRAME_OVERHEAD_BYTES } from '../../../server/scheduler/initial/index.mjs';
import { buildTerrainTile, terrainTileToMesh, terrainLodStride } from '../../../server/terrain/mesh_lod/index.mjs';
import { TERRAIN_LOD_COUNT, TERRAIN_LOD_MAX_ERROR_M } from '../../../contracts/tower_assets/index.mjs';
import { TERRAIN_SSIM_MIN, TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { EMPTY_INDEX } from '../../../contracts/raster/index.mjs';
import { ssimDetailed } from '../../../server/metrics/ssim/index.mjs';
import { lambert as serverLambert } from '../../../server/raster_ref/shade/index.mjs';
import { towerViewpoints, TOWER_EYE_MIN_U_M } from '../../../client/tower/terrain/fixtures.mjs';
import { createTerrainLayer } from '../../../client/tower/terrain/index.mjs';
import { createTracer } from '../../../client/tower/terrain/ref_trace.mjs';
import { B1_OPTIONS, lodStrides, buildTileWithStride } from './b1_lod.mjs';

const SPAN_M = 1024;
const MESH_HEADER_BYTES = 16;
// SSIM 창: ssim_views 와 같은 4×4 타일.
const VIEW_TILE_MIN = -2, VIEW_TILE_MAX = 1;
// 시점 전제의 지형 상한(m) = 눈 높이 하한 17 m − 2 m (fixtures.mjs 머리 주석).
const TERRAIN_TOP_M = TOWER_EYE_MIN_U_M - 2;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const LOW_NOISE_HALF_M = 0.15; // ±0.15 m
const DELTA_D_M = 0.33; // 참고값만(판정에 쓰지 않음): renderer_basis §3-7 표(1 px 시차, d = 45.3 m, b = 8.26 m)

/** lod_bytes.mjs 의 hashNoise 와 같은 식(내보내지 않아 옮김). ∈ [−0.5, 0.5]. */
function hashNoise(i, j, seed = 0) {
  let x = ((i + seed * 31) * 73856093) ^ (j * 19349663);
  x = Math.imul(x ^ (x >>> 13), 0x5bd1e995);
  x ^= x >>> 15;
  return ((x >>> 0) % 1001) / 1000 - 0.5;
}

/** smooth + ±0.15 m 화소 잡음. lod_bytes.mjs makeDem 과 같은 격자. */
export function lowNoiseDem(seed, cellM = 1) {
  const side = SPAN_M / cellM + 1;
  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const x = i * cellM - SPAN_M / 2, y = j * cellM - SPAN_M / 2;
      heights[j * side + i] = 20 + 25 * Math.sin(x / 300) * Math.cos(y / 400) + 2 * LOW_NOISE_HALF_M * hashNoise(i, j, seed);
    }
  }
  return { originX: -SPAN_M / 2, originY: -SPAN_M / 2, cellM, width: side, height: side, heights };
}

function demSet() {
  const out = [{ name: 'smooth', make: () => smoothDem() }];
  for (const s of SEEDS) out.push({ name: `noiseBig:${s}`, make: () => noiseBigDem(s) });
  for (const s of SEEDS) out.push({ name: `lowNoise:${s}`, make: () => lowNoiseDem(s) });
  return out;
}

function tileBytes(cells) {
  const mesh = PIECE_FRAME_OVERHEAD_BYTES + MESH_HEADER_BYTES + cells * cells * 3 * 4 + (cells - 1) * (cells - 1) * 6 * 4;
  const heightOnly = PIECE_FRAME_OVERHEAD_BYTES + MESH_HEADER_BYTES + cells * cells * 4;
  return { mesh, heightOnly };
}

/** ssim_views concatMeshes 와 같은 이어 붙이기(시험 쪽 독립 구현을 옮김). zShift 만큼 높이를 내린다. */
function concatMeshes(meshes, zShift) {
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
  if (zShift) for (let k = 2; k < positions.length; k += 3) positions[k] -= zShift;
  return { positions, indices, tileOfTriangle };
}

function shiftTiles(tiles, zShift) {
  if (!zShift) return tiles;
  return tiles.map((t) => ({ ...t, heights: t.heights.map((h) => h - zShift) }));
}

function shadeFnDefault() {
  return (normal) => serverLambert(normal, TERRAIN_DEFAULTS.lightDirEnu, TERRAIN_DEFAULTS.baseRgb, { ambient: TERRAIN_DEFAULTS.ambient });
}

function viewTileOrder() {
  const order = [];
  for (let ty = VIEW_TILE_MIN; ty <= VIEW_TILE_MAX; ty++) for (let tx = VIEW_TILE_MIN; tx <= VIEW_TILE_MAX; tx++) order.push([tx, ty]);
  return order;
}

/** 현행표에서 이 사본이 서버 함수와 같은 간격·높이를 내는지 대조한다. 다르면 던진다. */
function checkAgainstServer(dem, stridesI) {
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    const s = terrainLodStride(dem, lod);
    if (s !== stridesI[lod]) throw new Error(`사본 간격 불일치 LOD ${lod}: 사본 ${stridesI[lod]} 서버 ${s}`);
    for (const [tx, ty] of [[-8, -8], [-1, 0], [7, 7]]) {
      const a = buildTerrainTile(dem, tx, ty, lod), b = buildTileWithStride(dem, tx, ty, lod, stridesI[lod]);
      if (a.cells !== b.cells || !a.heights.every((v, k) => v === b.heights[k])) throw new Error(`사본 타일 불일치 LOD ${lod} (${tx},${ty})`);
    }
  }
}

/**
 * DEM 하나를 상한표 묶음 optionTable 로 잰다. b5_measure.mjs 가 다른 상한표·DEM(2 m 셀 hill 등)으로 다시 쓴다.
 * 바이트의 타일 수·cells 는 DEM 에서 구한다(1024 m·1 m 셀이면 256 타일·cells = 64/간격+1 로 이전과 같다).
 * check 는 optionTable.i 가 현행표일 때만 뜻이 있다(서버 함수 대조).
 */
export function measureDem(entry, cams, { check, optionTable = B1_OPTIONS }) {
  const t0 = Date.now();
  const dem = entry.make();
  const n0 = Math.round(64 / dem.cellM);
  const tileCount = ((dem.width - 1) / n0) * ((dem.height - 1) / n0);
  if (!Number.isInteger(tileCount)) throw new Error('DEM 이 타일 격자에 맞지 않는다');
  const per = {};
  for (const [opt, bounds] of Object.entries(optionTable)) per[opt] = lodStrides(dem, bounds);
  if (check) checkAgainstServer(dem, per.i.strides);

  // SSIM: 기준 영상(LOD 0)과 간격별 층 영상.
  const order = viewTileOrder();
  const lod0Tiles = order.map(([tx, ty]) => buildTileWithStride(dem, tx, ty, 0, 1));
  let maxZ = -Infinity;
  for (const t of lod0Tiles) for (const h of t.heights) if (h > maxZ) maxZ = h;
  const zShift = Math.max(0, Math.ceil(maxZ - TERRAIN_TOP_M));
  const refMesh = concatMeshes(lod0Tiles.map((t) => terrainTileToMesh(t)), zShift);
  const tracer = createTracer(refMesh, { normals: 'vertex' });
  const refs = cams.map((c) => tracer(c, shadeFnDefault()));
  // 기준 영상 채움 비율(시점별): 화면이 비어 SSIM 이 뜻 없이 높아지는 경우를 드러낸다(ssim_views 는 시점마다 > 0.05 를 요구).
  const refFill = refs.map((r) => { let f = 0; for (const k of r.index) if (k !== EMPTY_INDEX) f++; return f / r.index.length; });
  const ssimByStride = new Map();
  const ssimFor = (lod, stride) => {
    if (ssimByStride.has(stride)) return ssimByStride.get(stride);
    const tiles = shiftTiles(order.map(([tx, ty]) => buildTileWithStride(dem, tx, ty, lod, stride)), zShift);
    const layer = createTerrainLayer();
    const act = layer.accept(lod, tiles);
    if (act !== 'first') throw new Error(`accept ${act}`);
    const ssim = [], filled = [];
    cams.forEach((c, v) => {
      const out = layer.render(c);
      const d = ssimDetailed(out.color, refs[v].color, out.width, out.height, 3);
      ssim.push(d.ssim); filled.push(d.ssimFilled);
    });
    const r = { ssim, filled, min: Math.min(...ssim), filledMin: Math.min(...filled.filter((x) => x !== null)) };
    ssimByStride.set(stride, r);
    return r;
  };

  const options = {};
  for (const [opt, bounds] of Object.entries(optionTable)) {
    const levels = [];
    for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
      const stride = per[opt].strides[lod];
      const cells = n0 / stride + 1;
      const b = tileBytes(cells);
      const s = ssimFor(lod, stride);
      levels.push({
        lod, boundM: bounds[lod], stride, cells, maxErrorM: per[opt].maxErrorM[lod],
        meshRawBytes: b.mesh * tileCount, heightOnlyRawBytes: b.heightOnly * tileCount,
        ssimMin8: s.min, ssim8: s.ssim, ssimFilledMin8: s.filledMin,
      });
    }
    const [l0, , l2, l3] = levels;
    options[opt] = {
      bounds: [...bounds],
      levels,
      lod3EqLod2: l3.stride === l2.stride,
      lod3EqLod0: l3.stride === l0.stride,
      lod3MeshOverInitialLimit: l3.meshRawBytes > INITIAL_LIMIT_BYTES,
      lod3HeightOnlyOverInitialLimit: l3.heightOnlyRawBytes > INITIAL_LIMIT_BYTES,
      lod1to3SsimPass: levels.slice(1).every((l) => l.ssimMin8 >= TERRAIN_SSIM_MIN),
    };
  }
  return { dem: entry.name, tileCount, zShiftM: zShift, viewMaxZ: maxZ, refFillMin: Math.min(...refFill), refFill, ms: Date.now() - t0, options };
}

function checkBytesAgainstLodBytes(result) {
  // 현행표 (i) 의 smooth 바이트가 lod_bytes.mjs measureLodBytes 와 같은지(같은 직렬화 정의인지) 대조한다.
  const ref = measureLodBytes(smoothDem());
  const mine = result.options.i.levels;
  ref.levels.forEach((l, k) => {
    if (l.rawBytes !== mine[k].meshRawBytes || l.heightOnlyBytes !== mine[k].heightOnlyRawBytes) {
      throw new Error(`lod_bytes 대조 불일치 LOD ${k}: ${l.rawBytes}/${l.heightOnlyBytes} 대 ${mine[k].meshRawBytes}/${mine[k].heightOnlyRawBytes}`);
    }
  });
}

const fmtB = (n) => n.toLocaleString('en-US');

export function measureAllOptions({ only = null, check = true } = {}) {
  if (JSON.stringify([...TERRAIN_LOD_MAX_ERROR_M]) !== JSON.stringify([...B1_OPTIONS.i])) {
    throw new Error(`계약 상한표 ${TERRAIN_LOD_MAX_ERROR_M} 가 안 (i) 과 다르다 — 서버 대조가 의미 없다`);
  }
  const cams = towerViewpoints();
  const dems = demSet().filter((d) => !only || only.includes(d.name));
  const results = [];
  for (const d of dems) {
    const r = measureDem(d, cams, { check });
    if (check && d.name === 'smooth') checkBytesAgainstLodBytes(r);
    results.push(r);
    console.error(`[b1] ${d.name} ${r.ms} ms`);
  }
  return {
    note: '[cloud] 합성 DEM 측정. 1024 m·1 m 셀·256 타일 바이트(raw), SSIM 은 가운데 4×4 타일·160×90·8시점(ssim_views 절차).',
    options: Object.fromEntries(Object.entries(B1_OPTIONS).map(([k, v]) => [k, [...v]])),
    ssimMin: TERRAIN_SSIM_MIN,
    initialLimitBytes: INITIAL_LIMIT_BYTES,
    lowNoiseHalfM: LOW_NOISE_HALF_M,
    deltaDM: DELTA_D_M,
    views: cams.map((c) => c.name),
    results,
  };
}

export function formatTable(all) {
  const lines = [];
  lines.push(`안 (i) ${JSON.stringify(all.options.i)}  안 (ii) ${JSON.stringify(all.options.ii)}  | SSIM 기준 ${all.ssimMin}(8시점 최소), 초기 상한 ${fmtB(all.initialLimitBytes)} B(raw)`);
  lines.push('DEM          안  LOD 상한m 간격 cells  최대오차m  메시raw(B)    높이만raw(B)  SSIM최소8  채움창최소 판정');
  for (const r of all.results) {
    for (const opt of ['i', 'ii']) {
      for (const l of r.options[opt].levels) {
        const verdict = l.lod === 0 ? '-' : (l.ssimMin8 >= all.ssimMin ? 'PASS' : 'FAIL');
        lines.push([
          r.dem.padEnd(12), opt.padEnd(3), String(l.lod).padStart(3), String(l.boundM).padStart(6), String(l.stride).padStart(4), String(l.cells).padStart(5),
          l.maxErrorM.toFixed(4).padStart(10), fmtB(l.meshRawBytes).padStart(12), fmtB(l.heightOnlyRawBytes).padStart(13),
          l.ssimMin8.toFixed(4).padStart(10), l.ssimFilledMin8.toFixed(4).padStart(10), verdict.padStart(5),
        ].join(' '));
      }
    }
  }
  lines.push('');
  lines.push('LOD3 요약: DEM | 안 | LOD3 메시raw | LOD3 높이만raw | LOD3=LOD2 | LOD3=LOD0 | 메시>15MB | 높이만>15MB | LOD3 SSIM | LOD1~3 모두≥기준 | z이동m | 기준채움최소');
  for (const r of all.results) {
    for (const opt of ['i', 'ii']) {
      const o = r.options[opt], l3 = o.levels[3];
      lines.push(`${r.dem.padEnd(12)} | ${opt.padEnd(2)} | ${fmtB(l3.meshRawBytes).padStart(11)} | ${fmtB(l3.heightOnlyRawBytes).padStart(10)} | ${o.lod3EqLod2 ? 'Y' : 'N'} | ${o.lod3EqLod0 ? 'Y' : 'N'} | ${o.lod3MeshOverInitialLimit ? 'Y' : 'N'} | ${o.lod3HeightOnlyOverInitialLimit ? 'Y' : 'N'} | ${l3.ssimMin8.toFixed(4)} | ${o.lod1to3SsimPass ? 'Y' : 'N'} | ${r.zShiftM} | ${r.refFillMin.toFixed(3)}`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const onlyArg = get('--only');
  const all = measureAllOptions({ only: onlyArg ? onlyArg.split(',') : null, check: !args.includes('--no-check') });
  console.log(formatTable(all));
  const jsonPath = get('--json');
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(all, null, 2) + '\n');
}
