// [cloud] T15.10e: H32(높이만 전송 형식, 결정 0058) 초기 지형 바이트 측정. 합성 DEM 만 쓴다(실제 DEM T14L 은 [local] 미측정).
// 하는 일: noiseBig(bench/tower/lod_bytes.mjs noiseBigDem, 시드 0~3)·완만 DEM(smoothDem)의 관제탑 범위 256 타일을
//   초기 지형 단계(bench/tower_assets INITIAL_TERRAIN_LOD = 3)로 잘라, 계약 contracts/tower_assets/terrain_h32.mjs 의
//   terrainH32Bytes·quantizeHeights 로 타일 바이트를 센다(비양자화 f32·양자화 u16 각각, 양자화 불가 타일은 f32 폴백으로 센다).
// 바이트 두 가지:
//   payload = 타일 H32 바이트 합(terrainH32Bytes, 머리 16 B (+8 B) + 본문).
//   wire    = payload + 타일마다 조각 프레임 머리 PIECE_FRAME_OVERHEAD_BYTES(조각 머리 + ws 머리 상한 10 B). 초기 몫은 raw 웹소켓
//             바이트이므로 판정은 wire 로 한다(보수적: ws 머리 상한을 쓴다).
// 비교: 지형 몫 TERRAIN_INITIAL_BUDGET_BYTES(10,780,163 B) 와, 초기 합계 = 건물 3,157,410 + 드레이프 밉2 1,062,400 + WELCOME 27 + 지형
//   을 INITIAL_TOTAL_LIMIT_BYTES(15,000,000 B) 와 비교한다. 건물·드레이프는 bench/tower_assets measureTowerAssets() breakdown 의 값
//   (bench/tower_assets/index.test.mjs 에 박힌 수)을 그대로 쓴다(그 측정은 무거워 여기서 다시 돌리지 않는다).
//   LEVEL_ARRIVED 프레임(31 B × (segment, level))은 몫 정의(결정 0056)에서 빼지 않았으므로 합계에 넣지 않고 값만 적는다.
// 서버 인코더 대조: server/terrain/height_format/index.mjs 가 있으면 encodeTerrainTileH32 로 실제 부호화해 길이 합을 계약 계산과 맞춘다.
//   없으면 대조하지 않고 결과의 encoder.available = false 로 표시한다.
// 판정은 값만 낸다(문턱으로 던지지 않는다). 시험은 h32_initial.test.mjs.
// 실행: node bench/tower/h32_initial.mjs [--json]
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { buildTerrainTile } from '../../server/terrain/mesh_lod/index.mjs';
import { PIECE_FRAME_OVERHEAD_BYTES, WELCOME_FRAME_BYTES, LEVEL_ARRIVED_FRAME_BYTES } from '../../server/scheduler/initial/index.mjs';
import {
  terrainH32Bytes, quantizeHeights, TERRAIN_INITIAL_BUDGET_BYTES, INITIAL_TOTAL_LIMIT_BYTES, TERRAIN_H32_FLAG_QUANTIZED,
} from '../../contracts/tower_assets/terrain_h32.mjs';
import { smoothDem, noiseBigDem } from './lod_bytes.mjs';

/** 초기 지형 단계(bench/tower_assets INITIAL_TERRAIN_LOD 와 같은 값, 그 모듈은 무거운 측정을 함께 싣고 있어 숫자로 둔다). */
export const INITIAL_TERRAIN_LOD = 3;
/** 건물 raw 바이트(bench/tower_assets breakdown.buildings, 합성 도시 6,191동 전체). */
export const BUILDINGS_BYTES = 3_157_410;
/** 드레이프 밉2 raw 바이트(bench/tower_assets breakdown.drape, 256 타일). */
export const DRAPE_MIP2_BYTES = 1_062_400;
/** WELCOME 프레임 바이트(server/scheduler/initial WELCOME_FRAME_BYTES). */
export const WELCOME_BYTES = 27;
const TILES_PER_SIDE = 16;
const ENCODER_PATH = new URL('../../server/terrain/height_format/index.mjs', import.meta.url);

function* towerTiles(n = TILES_PER_SIDE) {
  for (let ty = -n / 2; ty < n / 2; ty++) for (let tx = -n / 2; tx < n / 2; tx++) yield [tx, ty];
}

/**
 * DEM 하나의 초기 지형(LOD lod, tilesPerSide² 타일) H32 바이트.
 * @returns {{ lod:number, cells:number, tiles:number, f32:{payload:number, wire:number},
 *   quant:{payload:number, wire:number, quantizedTiles:number, fallbackTiles:number} }}
 */
export function measureH32Initial(dem, { lod = INITIAL_TERRAIN_LOD, tilesPerSide = TILES_PER_SIDE } = {}) {
  if (!Number.isInteger(tilesPerSide) || tilesPerSide <= 0 || tilesPerSide % 2 !== 0) {
    throw new RangeError(`tilesPerSide 는 양의 짝수 정수, got ${tilesPerSide}`);
  }
  let cells = 0, tiles = 0, f32 = 0, quant = 0, quantizedTiles = 0, fallbackTiles = 0;
  for (const [tx, ty] of towerTiles(tilesPerSide)) {
    const tile = buildTerrainTile(dem, tx, ty, lod);
    cells = tile.cells;
    f32 += terrainH32Bytes(tile.cells, false);
    // 계약: LOD 0 은 늘 비양자화, 범위 초과·비유한이면 f32 폴백.
    const q = lod >= 1 ? quantizeHeights(tile.heights) : null;
    if (q) { quant += terrainH32Bytes(tile.cells, true); quantizedTiles++; }
    else { quant += terrainH32Bytes(tile.cells, false); fallbackTiles++; }
    tiles++;
  }
  const frames = tiles * PIECE_FRAME_OVERHEAD_BYTES;
  return {
    lod, cells, tiles,
    f32: { payload: f32, wire: f32 + frames },
    quant: { payload: quant, wire: quant + frames, quantizedTiles, fallbackTiles },
  };
}

/** 지형 wire 바이트를 몫·초기 합계와 비교. */
export function compareBudget(terrainWire) {
  const total = BUILDINGS_BYTES + DRAPE_MIP2_BYTES + WELCOME_BYTES + terrainWire;
  return {
    terrainWire,
    shareLimit: TERRAIN_INITIAL_BUDGET_BYTES,
    shareMargin: TERRAIN_INITIAL_BUDGET_BYTES - terrainWire,
    sharePass: terrainWire <= TERRAIN_INITIAL_BUDGET_BYTES,
    total,
    totalLimit: INITIAL_TOTAL_LIMIT_BYTES,
    totalMargin: INITIAL_TOTAL_LIMIT_BYTES - total,
    totalPass: total <= INITIAL_TOTAL_LIMIT_BYTES,
  };
}

/** 서버 인코더가 있으면 불러온다(없으면 null). */
export async function loadEncoder() {
  if (!existsSync(ENCODER_PATH)) return null;
  const mod = await import(ENCODER_PATH.href);
  return typeof mod.encodeTerrainTileH32 === 'function' ? mod.encodeTerrainTileH32 : null;
}

/**
 * 서버 인코더 기본 호출(encodeTerrainTileH32(tile))로 부호화한 실제 길이 합과, 같은 타일의 계약 계산(머리 flags 의 양자화 비트 기준)을 맞춘다.
 * @returns {{ available:false }|{ available:true, payload:number, expectedPayload:number, quantizedTiles:number, fallbackTiles:number, mismatchTiles:number }}
 */
export async function crossCheckEncoder(dem, { lod = INITIAL_TERRAIN_LOD, tilesPerSide = TILES_PER_SIDE } = {}) {
  const encode = await loadEncoder();
  if (!encode) return { available: false };
  let payload = 0, expectedPayload = 0, quantizedTiles = 0, fallbackTiles = 0, mismatchTiles = 0;
  for (const [tx, ty] of towerTiles(tilesPerSide)) {
    const tile = buildTerrainTile(dem, tx, ty, lod);
    const bytes = encode(tile);
    const quantized = (bytes[3] & TERRAIN_H32_FLAG_QUANTIZED) !== 0;
    const expected = terrainH32Bytes(tile.cells, quantized);
    if (quantized) quantizedTiles++; else fallbackTiles++;
    if (bytes.byteLength !== expected) mismatchTiles++;
    payload += bytes.byteLength;
    expectedPayload += expected;
  }
  return { available: true, payload, expectedPayload, quantizedTiles, fallbackTiles, mismatchTiles };
}

/** noiseBig 시드 0~3 과 완만 DEM 의 초기 지형 측정 + 예산 비교 + 인코더 대조. */
export async function measureAllH32({ seeds = [0, 1, 2, 3], withEncoder = true } = {}) {
  const dems = {};
  for (const s of seeds) dems[`noiseBig:${s}`] = () => noiseBigDem(s);
  dems.smooth = () => smoothDem();
  const rows = {};
  for (const [name, make] of Object.entries(dems)) {
    const dem = make();
    const m = measureH32Initial(dem);
    rows[name] = {
      ...m,
      budgetF32: compareBudget(m.f32.wire),
      budgetQuant: compareBudget(m.quant.wire),
      encoder: withEncoder ? await crossCheckEncoder(dem) : { available: false, skipped: true },
    };
  }
  return {
    lod: INITIAL_TERRAIN_LOD,
    pieceFrameOverhead: PIECE_FRAME_OVERHEAD_BYTES,
    welcomeFrameBytes: WELCOME_FRAME_BYTES,
    levelArrivedEach: LEVEL_ARRIVED_FRAME_BYTES,
    fixed: { buildings: BUILDINGS_BYTES, drape: DRAPE_MIP2_BYTES, welcome: WELCOME_BYTES },
    rows,
  };
}

function print(r) {
  const pad = (s, n) => String(s).padStart(n);
  console.log(`# T15.10e H32 초기 지형 바이트 [cloud 합성 DEM] LOD${r.lod}, 256 타일, 조각 프레임 머리 ${r.pieceFrameOverhead} B/타일`);
  console.log(`고정: 건물 ${r.fixed.buildings} + 드레이프 밉2 ${r.fixed.drape} + WELCOME ${r.fixed.welcome}; 지형 몫 ${TERRAIN_INITIAL_BUDGET_BYTES}, 합계 상한 ${INITIAL_TOTAL_LIMIT_BYTES}`);
  console.log('| DEM | cells | f32 payload | f32 wire | 양자화 payload | 양자화 wire | 폴백 타일 | 몫 여유(f32/양자화) | 합계(f32/양자화) | 판정 | 인코더 대조 |');
  for (const [name, x] of Object.entries(r.rows)) {
    const pass = x.budgetQuant.sharePass && x.budgetQuant.totalPass && x.budgetF32.sharePass && x.budgetF32.totalPass ? 'PASS' : 'FAIL';
    const enc = x.encoder.available ? `${x.encoder.payload}/${x.encoder.expectedPayload} 불일치 ${x.encoder.mismatchTiles}` : '대조 불가(인코더 없음)';
    console.log(`| ${name} | ${x.cells} | ${pad(x.f32.payload, 9)} | ${pad(x.f32.wire, 9)} | ${pad(x.quant.payload, 9)} | ${pad(x.quant.wire, 9)} | ${x.quant.fallbackTiles} | `
      + `${x.budgetF32.shareMargin}/${x.budgetQuant.shareMargin} | ${x.budgetF32.total}/${x.budgetQuant.total} | ${pass} | ${enc} |`);
  }
  console.log(`합계는 스케줄러 LEVEL_ARRIVED 프레임 ${r.levelArrivedEach} B/(segment, level)를 제외한 값이다(몫 정의 결정 0056 에 없음, 위 합계 열에 포함되지 않음).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await measureAllH32();
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else print(r);
}
