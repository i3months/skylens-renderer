// [cloud] T15.10b-B4 (F-458·F-457 ①): 높이만 보내는 지형 전송 형식 검토 측정. 합성 DEM 만 쓴다(실제 DEM T14L 은 [local] 미측정).
// 하는 일
//   1) 바이트: 완만 DEM·noiseBig(bench/tower/lod_bytes.mjs 의 smoothDem·noiseBigDem, 1024 m, 64 m 타일 256장, 1 m 셀)의
//      LOD0~3 타일을 형식별(b4_formats.mjs: MESH·H32·Q16·BPO·BPP)로 실제 부호화해 raw 바이트 합(프레임 머리 포함)을 낸다.
//   2) 복원 오차: 형식별 복원 높이로 만든 타일의 메시 표면 대 원본 DEM 최대 오차(server measureTerrainError)를
//      계약 상한 TERRAIN_LOD_MAX_ERROR_M 및 '상한 + step/2' 와 비교한다.
//   3) SSIM: client/tower/terrain/ssim_views.test.mjs 와 같은 절차(8시점 160×90, 기준 = LOD0 f32 메시 ref_trace,
//      층 = createTerrainLayer)로 형식별 복원 높이를 그려 8시점 최소 SSIM 을 낸다.
//      장면: (a) 시험 장면 24개(makeHillDem 시드 1~12 × 잡음 {0, 0.015}, 2 m 셀), (b) 완만 DEM 가운데 4×4 타일(높이 −20 m 이동,
//      눈 높이 17 m 시점 아래로 내리기 위함), (c) noiseBig 가운데 4×4 타일. (b)(c) 의 LOD 간격은 잘라낸 DEM 에서 다시 정해진다.
//   4) 초기 예산: 남은 예산 = 15,000,000 − 건물 − 드레이프 밉2 − WELCOME 프레임. 건물·드레이프는 bench/tower_assets
//      measureTowerAssets() 를 그대로 돌려 얻고(breakdown), WELCOME 은 server/scheduler/initial WELCOME_FRAME_BYTES.
//      LEVEL_ARRIVED 프레임(31 B × (segment, level) 수)은 관제탑 자산에서 개수가 정해져 있지 않아 빼지 않았다(값은 표기).
//      초기 지형 단계는 bench/tower_assets INITIAL_TERRAIN_LOD(=3). 범위는 시야 선택 없는 256 타일 전부(보수적).
// 판정은 raw 바이트로 한다(서버 ws 에 permessage-deflate 없음). 문턱으로 던지지 않고 값만 낸다.
// 실행: node bench/tower/terrain_options/b4_measure.mjs [--quick] [--json]
//   --quick: SSIM 시험 장면을 시드 {1, 7} × 잡음 {0, 0.015} 4개로 줄인다(기본은 24 장면 전부).
import { fileURLToPath } from 'node:url';
import { buildTerrainTile, measureTerrainError } from '../../../server/terrain/mesh_lod/index.mjs';
import { TERRAIN_LOD_COUNT, TERRAIN_LOD_MAX_ERROR_M } from '../../../contracts/tower_assets/index.mjs';
import { WELCOME_FRAME_BYTES, LEVEL_ARRIVED_FRAME_BYTES, INITIAL_BUDGET_BYTES } from '../../../server/scheduler/initial/index.mjs';
import { TERRAIN_SSIM_MIN, TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { smoothDem, noiseBigDem } from '../lod_bytes.mjs';
import { meshPieceBytes, h32PieceBytes, encodeQuantized } from './b4_formats.mjs';

export const STEPS_M = Object.freeze([0.01, 0.05, 0.1, 0.25, 0.5]);
const SPAN_TILES = 16;
const LODS = [0, 1, 2, 3];

function towerTiles(n = SPAN_TILES) {
  const out = [];
  for (let ty = -n / 2; ty < n / 2; ty++) for (let tx = -n / 2; tx < n / 2; tx++) out.push([tx, ty]);
  return out;
}

// ---------------- 1)·2) 바이트와 복원 오차 ----------------

/** DEM 하나의 LOD 별 형식 바이트 합·복원 최대 오차. */
export function measureFormats(dem, { tilesPerSide = SPAN_TILES, steps = STEPS_M } = {}) {
  const levels = [];
  for (const lod of LODS) {
    const row = { lod, cells: 0, mesh: 0, h32: 0, q16: 0, errF32: 0, q: {} };
    for (const s of steps) row.q[s] = { bpo: 0, bpp: 0, bpx: 0, err: 0, bitsOMax: 0, bitsPMax: 0, bitsPSum: 0 };
    let n = 0;
    for (const [tx, ty] of towerTiles(tilesPerSide)) {
      const tile = buildTerrainTile(dem, tx, ty, lod);
      row.cells = tile.cells;
      row.mesh += meshPieceBytes(tile);
      row.h32 += h32PieceBytes(tile);
      row.errF32 = Math.max(row.errF32, measureTerrainError(dem, tile).maxErrorM);
      let q16 = 0;
      for (const s of steps) {
        const e = encodeQuantized(tile, s);
        q16 = e.q16;
        const r = row.q[s];
        r.bpo += e.bpo; r.bpp += e.bpp; r.bpx += e.bpx;
        r.bitsOMax = Math.max(r.bitsOMax, e.bitsO); r.bitsPMax = Math.max(r.bitsPMax, e.bitsP); r.bitsPSum += e.bitsP;
        r.err = Math.max(r.err, measureTerrainError(dem, { ...tile, heights: e.heights }).maxErrorM);
      }
      row.q16 += q16;
      n++;
    }
    row.tiles = n;
    for (const s of steps) row.q[s].bitsPMean = row.q[s].bitsPSum / n;
    levels.push(row);
  }
  return levels;
}

// ---------------- 3) 8시점 SSIM ----------------

let ssimMods = null;
async function loadSsimMods() {
  if (ssimMods) return ssimMods;
  const fx = await import('../../../client/tower/terrain/fixtures.mjs');
  const layer = await import('../../../client/tower/terrain/index.mjs');
  const ref = await import('../../../client/tower/terrain/ref_trace.mjs');
  const ss = await import('../../../server/metrics/ssim/index.mjs');
  const shade = await import('../../../server/raster_ref/shade/index.mjs');
  const { terrainTileToMesh } = await import('../../../server/terrain/mesh_lod/index.mjs');
  ssimMods = { ...fx, ...layer, ...ref, ssimDetailed: ss.ssimDetailed, serverLambert: shade.lambert, terrainTileToMesh, cams: fx.towerViewpoints() };
  return ssimMods;
}

/** 시험 쪽과 같은 이어붙이기(ssim_views.test.mjs concatMeshes 와 같은 식). */
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

/**
 * DEM 하나(타일 -2..1 × -2..1)의 형식 변형별 LOD 0..3 8시점 SSIM.
 * @returns {{ variants: { [name:string]: { ssim:number[][], err:number[] } } }}  ssim[lod][view], err[lod] = 복원 메시 최대 오차
 */
async function ssimScene(dem, steps) {
  const m = await loadSsimMods();
  const order = [];
  for (let ty = -2; ty < 2; ty++) for (let tx = -2; tx < 2; tx++) order.push([tx, ty]);
  const lodTiles = LODS.map((l) => order.map(([tx, ty]) => buildTerrainTile(dem, tx, ty, l)));
  const refMesh = concatMeshes(lodTiles[0].map((t) => m.terrainTileToMesh(t)));
  const shadeFn = (n) => m.serverLambert(n, TERRAIN_DEFAULTS.lightDirEnu, TERRAIN_DEFAULTS.baseRgb, { ambient: TERRAIN_DEFAULTS.ambient });
  const tracer = m.createTracer(refMesh, { normals: 'vertex' });
  const refs = m.cams.map((c) => tracer(c, shadeFn));
  const variants = { f32: { ssim: [], err: [] } };
  for (const s of steps) variants[`q${s}`] = { ssim: [], err: [] };
  for (const l of LODS) {
    const sets = { f32: lodTiles[l] };
    for (const s of steps) sets[`q${s}`] = lodTiles[l].map((t) => ({ ...t, heights: encodeQuantized(t, s).heights }));
    for (const [name, tiles] of Object.entries(sets)) {
      const layer = m.createTerrainLayer();
      layer.accept(l, tiles);
      variants[name].ssim.push(m.cams.map((c, v) => {
        const out = layer.render(c);
        return m.ssimDetailed(out.color, refs[v].color, out.width, out.height, 3).ssim;
      }));
      variants[name].err.push(Math.max(...tiles.map((t) => measureTerrainError(dem, t).maxErrorM)));
    }
  }
  return { variants };
}

/** 1024 m DEM 의 가운데 4×4 타일(x,y ∈ [-128,128])을 잘라낸다. dz 만큼 높이를 옮긴다. */
function cropCenter(dem, dz = 0) {
  const side = 257, off = (dem.width - side) / 2;
  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) heights[j * side + i] = Math.fround(dem.heights[(j + off) * dem.width + i + off] + dz);
  return { originX: -128, originY: -128, cellM: dem.cellM, width: side, height: side, heights };
}

/** 장면 집합의 형식·LOD 별 최소 SSIM, f32 대비 최대 하락, 최대 복원 오차. */
function summarize(results, steps) {
  const names = ['f32', ...steps.map((s) => `q${s}`)];
  const out = {};
  for (const name of names) {
    out[name] = LODS.map((l) => {
      let min = Infinity, drop = 0, err = 0, where = '';
      for (const r of results) {
        const v = r.variants[name];
        const base = r.variants.f32.ssim[l];
        v.ssim[l].forEach((x, k) => {
          if (x < min) { min = x; where = `${r.label}/v${k}`; }
          drop = Math.max(drop, base[k] - x);
        });
        err = Math.max(err, v.err[l]);
      }
      return { min, drop, err, where };
    });
  }
  return out;
}

export async function measureSsim({ quick = false, steps = STEPS_M } = {}) {
  const m = await loadSsimMods();
  const seeds = quick ? [1, 7] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const hill = [];
  for (const noise of [0, 0.015]) {
    for (const seed of seeds) {
      const r = await ssimScene(m.makeHillDem({ seed, noiseRatio: noise }), steps);
      r.label = `${seed}/${noise}`;
      hill.push(r);
      process.stderr.write(`[b4] SSIM 시험 장면 ${r.label} 끝\n`);
    }
  }
  const smooth = await ssimScene(cropCenter(smoothDem(), -20), steps);
  smooth.label = 'smooth';
  process.stderr.write('[b4] SSIM 완만 끝\n');
  const noisy = await ssimScene(cropCenter(noiseBigDem(0)), steps);
  noisy.label = 'noiseBig';
  process.stderr.write('[b4] SSIM noiseBig 끝\n');
  return {
    sceneCount: hill.length,
    hill: summarize(hill, steps),
    smooth: summarize([smooth], steps),
    noiseBig: summarize([noisy], steps),
  };
}

// ---------------- 4) 초기 예산 ----------------

export async function measureBudget() {
  const { measureTowerAssets, INITIAL_TERRAIN_LOD, INITIAL_DRAPE_MIP, INITIAL_LIMIT_BYTES } = await import('../../tower_assets/index.mjs');
  const log = console.log;
  console.log = () => {}; // measureTowerAssets 의 진행 출력을 숨긴다
  let r;
  try { r = measureTowerAssets(); } finally { console.log = log; }
  const buildings = r.breakdown.buildings;
  const drape = r.breakdown.drape;
  if (INITIAL_LIMIT_BYTES !== INITIAL_BUDGET_BYTES) throw new Error('초기 상한 두 상수가 다르다');
  return {
    limit: INITIAL_LIMIT_BYTES, buildings, drape, drapeMip: INITIAL_DRAPE_MIP, welcome: WELCOME_FRAME_BYTES,
    levelArrivedEach: LEVEL_ARRIVED_FRAME_BYTES, terrainLod: INITIAL_TERRAIN_LOD,
    remaining: INITIAL_LIMIT_BYTES - buildings - drape - WELCOME_FRAME_BYTES,
  };
}

// ---------------- 출력 ----------------

const mb = (b) => (b / 1e6).toFixed(3);
const pad = (s, n) => String(s).padStart(n);
const padE = (s, n) => String(s).padEnd(n);

function printBytes(name, levels, steps) {
  console.log(`\n### 바이트(raw, 256 타일, 프레임 머리 포함) — ${name}`);
  console.log(`cells(LOD0..3): ${levels.map((r) => r.cells).join(' / ')}`);
  console.log(`${padE('형식', 22)}| ${LODS.map((l) => pad(`LOD${l} B`, 12)).join(' | ')} | LOD3 MB | LOD3/MESH`);
  const rows = [['MESH f32xyz+u32', (r) => r.mesh], ['H32 높이 f32', (r) => r.h32], ['Q16 높이 u16(모든 step)', (r) => r.q16]];
  for (const s of steps) rows.push([`BPO step ${s}`, (r) => r.q[s].bpo]);
  for (const s of steps) rows.push([`BPP step ${s}`, (r) => r.q[s].bpp]);
  for (const s of steps) rows.push([`BPX step ${s}`, (r) => r.q[s].bpx]);
  for (const [label, f] of rows) {
    const v = levels.map(f);
    console.log(`${padE(label, 22)}| ${v.map((x) => pad(x, 12)).join(' | ')} | ${pad(mb(v[3]), 7)} | ${(v[3] / levels[3].mesh).toFixed(4)}`);
  }
  console.log(`BPP 비트 폭(LOD0..3, 타일 평균/최대): ${steps.map((s) => `step ${s}: ${levels.map((r) => `${r.q[s].bitsPMean.toFixed(1)}/${r.q[s].bitsPMax}`).join(' ')}`).join(' | ')}`);
}

function printErrors(name, levels, steps) {
  console.log(`\n### 복원 최대 오차(m, 메시 표면 대 원본 DEM, 256 타일) — ${name}`);
  console.log(`${padE('형식', 18)}| ${LODS.map((l) => pad(`LOD${l}(상한 ${TERRAIN_LOD_MAX_ERROR_M[l]})`, 16)).join(' | ')}`);
  console.log(`${padE('f32(MESH=H32)', 18)}| ${levels.map((r) => pad(r.errF32.toFixed(4), 16)).join(' | ')}`);
  for (const s of steps) {
    const cells = levels.map((r, l) => {
      const e = r.q[s].err;
      const flag = e > TERRAIN_LOD_MAX_ERROR_M[l] ? ' 초과' : '';
      return pad(`${e.toFixed(4)}${flag}`, 16);
    });
    console.log(`${padE(`양자화 step ${s}`, 18)}| ${cells.join(' | ')}`);
  }
}

function printSsim(title, sum, steps) {
  console.log(`\n### 8시점 SSIM — ${title} (최소 / f32 대비 최대 하락 / 복원 최대 오차 m; 기준 ${TERRAIN_SSIM_MIN})`);
  console.log(`${padE('형식', 14)}| ${LODS.map((l) => pad(`LOD${l}`, 30)).join(' | ')}`);
  for (const name of ['f32', ...steps.map((s) => `q${s}`)]) {
    const cells = sum[name].map((c) => pad(`${c.min.toFixed(4)}${c.min < TERRAIN_SSIM_MIN ? '!' : ' '} / ${c.drop.toFixed(4)} / ${c.err.toFixed(3)}`, 30));
    console.log(`${padE(name === 'f32' ? 'f32' : `step ${name.slice(1)}`, 14)}| ${cells.join(' | ')}`);
  }
  const worst = sum[`q${steps[steps.length - 1]}`].map((c) => c.where).join(' ');
  console.log(`(가장 거친 step 의 최소 위치 LOD0..3: ${worst}; '!' = ${TERRAIN_SSIM_MIN} 미만)`);
}

function printBudget(b, dems, steps) {
  console.log('\n### 초기 15 MB 예산 대비(raw)');
  console.log(`상한 ${b.limit} B − 건물 ${b.buildings} B(bench/tower_assets breakdown.buildings, 합성 도시 6,191동 전체) − 드레이프 밉${b.drapeMip} ${b.drape} B(breakdown.drape, 256 타일)`
    + ` − WELCOME ${b.welcome} B(server/scheduler/initial WELCOME_FRAME_BYTES) = 남은 예산 ${b.remaining} B (${mb(b.remaining)} MB)`);
  console.log(`LEVEL_ARRIVED ${b.levelArrivedEach} B/(segment, level) 는 개수 미정이라 빼지 않음(1,000개여도 ${b.levelArrivedEach * 1000} B).`);
  console.log(`${padE('DEM', 9)}| ${padE('형식', 18)}| ${pad(`초기 LOD${b.terrainLod} B`, 14)} | 판정 | ${pad('여유 B', 12)} | ${pad('LOD0(최악) B', 14)} | LOD0 판정`);
  for (const [dname, levels] of Object.entries(dems)) {
    const rows = [['MESH', (r) => r.mesh], ['H32', (r) => r.h32], ['Q16', (r) => r.q16]];
    for (const s of steps.slice(0, 3)) rows.push([`BPX step ${s}`, (r) => r.q[s].bpx]);
    for (const [label, f] of rows) {
      const init = f(levels[b.terrainLod]);
      const worst = f(levels[0]);
      console.log(`${padE(dname, 9)}| ${padE(label, 18)}| ${pad(init, 14)} | ${init <= b.remaining ? 'PASS' : 'FAIL'} | ${pad(b.remaining - init, 12)} | ${pad(worst, 14)} | ${worst <= b.remaining ? 'PASS' : 'FAIL'}`);
    }
  }
}

async function main() {
  const quick = process.argv.includes('--quick');
  const asJson = process.argv.includes('--json');
  const t0 = Date.now();
  const dems = { smooth: measureFormats(smoothDem()), noiseBig: measureFormats(noiseBigDem(0)) };
  process.stderr.write(`[b4] 바이트·오차 끝 ${Date.now() - t0} ms\n`);
  const budget = await measureBudget();
  const ssim = await measureSsim({ quick });
  process.stderr.write(`[b4] 전체 ${Date.now() - t0} ms\n`);
  if (asJson) {
    console.log(JSON.stringify({ steps: STEPS_M, maxErrorM: [...TERRAIN_LOD_MAX_ERROR_M], dems, budget, ssim }, null, 2));
    return;
  }
  console.log('# T15.10b-B4 지형 전송 형식 비교 [cloud 합성 DEM, 실제 DEM 은 [local] 미측정]');
  console.log(`LOD 오차 상한 ${JSON.stringify([...TERRAIN_LOD_MAX_ERROR_M])} m, 양자화 step ${STEPS_M.join(', ')} m (양자화 오차 상한 step/2). TERRAIN_LOD_COUNT ${TERRAIN_LOD_COUNT}.`);
  for (const [n, lv] of Object.entries(dems)) { printBytes(n, lv, STEPS_M); printErrors(n, lv, STEPS_M); }
  printSsim(`시험 장면 ${ssim.sceneCount}개(makeHillDem, 2 m 셀, 4×4 타일)`, ssim.hill, STEPS_M);
  printSsim('완만 DEM 가운데 4×4 타일(−20 m 이동, 1 m 셀)', ssim.smooth, STEPS_M);
  printSsim('noiseBig 가운데 4×4 타일(1 m 셀)', ssim.noiseBig, STEPS_M);
  printBudget(budget, dems, STEPS_M);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
