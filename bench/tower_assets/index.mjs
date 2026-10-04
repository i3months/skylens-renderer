// T14 관제탑 자산 벤치마크: 합성 도시 6,191동 처리 성능·크기 측정.
// 외부 의존성 없음, 결정적 PRNG 시드 고정.

import { mulberry32, subSeed } from '../../contracts/scenes/index.mjs';
import { extrudeAll } from '../../server/buildings/extrude/index.mjs';
import { buildBuildingLod } from '../../server/buildings/lod/index.mjs';
import { buildTerrainTile, terrainTileToMesh } from '../../server/terrain/mesh_lod/index.mjs';
import { buildDrapeTile } from '../../server/terrain/drape/index.mjs';
import { PIECE_FRAME_OVERHEAD_BYTES } from '../../server/scheduler/initial/index.mjs';
import { TERRAIN_LOD_COUNT, DRAPE_MIP_COUNT } from '../../contracts/tower_assets/index.mjs';

// 초기에 보낼 단계(명시). 초기 묶음은 가장 거친 지형 LOD 를 보내고, 드레이프는 밉2 를 보낸다.
// 밉0(0.5 m/px)은 비교용으로 따로 합산한다.
export const INITIAL_TERRAIN_LOD = 3;
export const INITIAL_DRAPE_MIP = 2;
// 초기 상한(B). 값을 바꾸지 않는다. 넘으면 exceeds 필드에 기록한다.
export const INITIAL_LIMIT_BYTES = 15_000_000;
// 관제탑 범위: 1 km² 보다 약간 큰 1024 m 정사각형 = 64 m 타일 16×16 = 256 개.
const TOWER_SPAN_M = 1024;
const TOWER_TILES_PER_SIDE = TOWER_SPAN_M / 64;
const DRAPE_PX_M = 0.5;

const CITY_COUNT = 6191;
const HALF = 2000; // x,z ∈ [-2000, 2000]
const SIDE_MIN = 8;
const SIDE_MAX = 30;
const H_MIN = 5;
const H_MAX = 60;
const GAP = 1;
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * 격자 셀 및 지터를 사용하여 결정적으로 6,191개의 건물을 생성한다.
 * @param {number} seed - PRNG 시드
 * @returns {Array<{ id: number, ring: Array<[number, number]>, floors?: number }>}
 */
function generateFootprints(seed) {
  const n = CITY_COUNT;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cell = (2 * HALF) / cols;
  const sideMax = Math.min(SIDE_MAX, cell - GAP);
  if (sideMax < SIDE_MIN) throw new Error('cell size too small');

  // 셀 순서를 결정적으로 섞어 앞 n 개를 쓴다(Fisher-Yates).
  const order = Array.from({ length: cols * cols }, (_, i) => i);
  const rs = mulberry32(subSeed(seed, 0));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rs() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const footprints = [];
  for (let i = 0; i < n; i++) {
    const rnd = mulberry32(subSeed(seed, i + 1));
    const c = order[i];
    const x0 = -HALF + (c % cols) * cell;
    const z0 = -HALF + Math.floor(c / cols) * cell;
    const w = r2(SIDE_MIN + rnd() * (sideMax - SIDE_MIN));
    const d = r2(SIDE_MIN + rnd() * (sideMax - SIDE_MIN));
    const m = GAP / 2;
    const minX = r2(x0 + m + 0.01 + rnd() * Math.max(0, cell - GAP - w - 0.02));
    const minZ = r2(z0 + m + 0.01 + rnd() * Math.max(0, cell - GAP - d - 0.02));
    const maxX = r2(minX + w);
    const maxZ = r2(minZ + d);

    // 층 수: 일부는 미정(undefined), 일부는 구체적 값
    const hasFloors = rnd() > 0.3; // 70% 층 지정, 30% 없음
    const floors = hasFloors ? Math.floor(2 + rnd() * 10) : undefined;

    // 사각 외곽(반시계)
    const ring = [[minX, minZ], [minX, maxZ], [maxX, maxZ], [maxX, minZ]];
    footprints.push({ id: i, ring, floors });
  }
  return footprints;
}

/**
 * 합성 DEM 생성: 1km×1km, 1m 셀
 * @param {number} seed
 * @returns {{ originX: number, originY: number, cellM: number, width: number, height: number, heights: Float32Array }}
 */
function generateDem(seed) {
  const cell = 1; // 1 m cells
  const side = TOWER_SPAN_M / cell + 1; // 표본 1025 = 타일 16 개 + 경계 표본
  const rnd = mulberry32(subSeed(seed, 999));

  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      // 간단한 합성 높이: 기본값 ≈ 10m + 약간의 변동
      heights[j * side + i] = 10 + rnd() * 5;
    }
  }

  return {
    originX: -TOWER_SPAN_M / 2,
    originY: -TOWER_SPAN_M / 2,
    cellM: cell,
    width: side,
    height: side,
    heights,
  };
}

/** 매끈한 DEM: 완만한 언덕(진폭 약 25 m, 파장 수백 m). LOD 가 일을 하면 단계별 크기가 달라진다. */
function generateSmoothDem() {
  const side = TOWER_SPAN_M + 1;
  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const x = i - TOWER_SPAN_M / 2;
      const y = j - TOWER_SPAN_M / 2;
      heights[j * side + i] = 20 + 25 * Math.sin(x / 300) * Math.cos(y / 400);
    }
  }
  return { originX: -TOWER_SPAN_M / 2, originY: -TOWER_SPAN_M / 2, cellM: 1, width: side, height: side, heights };
}

/** 위성 영상 합성(결정적): 0.5 m/px, 관제탑 범위 전체. */
function generateImage() {
  const n = TOWER_SPAN_M / DRAPE_PX_M;
  const rgb = new Uint8Array(n * n * 3);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const o = (r * n + c) * 3;
      rgb[o] = (c * 7 + r * 3) & 255;
      rgb[o + 1] = (c * 5 + r * 11) & 255;
      rgb[o + 2] = (c + r * 13) & 255;
    }
  }
  const h = TOWER_SPAN_M / 2;
  return { width: n, height: n, rgb, bounds: { minX: -h, minY: -h, maxX: h, maxY: h } };
}

// ---- 형식 직렬화 크기 ----
// 조각 하나 = 프레임 머리(PIECE 머리 + ws 머리 상한, 초기 묶음과 같은 상수) + 조각 머리 + 본문.
// 메시 조각 머리 16 B(정점 수 u32, 인덱스 수 u32, tx i32, ty i32), 드레이프 조각 머리 16 B(tx i32, ty i32, 폭 u16, 높이 u16, 밉 u8, 예약 3 B).
// 본문은 positions(f32) → indices(u32) 또는 rgb(u8) 순으로 이어 쓴다. 실제 Buffer 에 써서 byteLength 로 센다.
// 드레이프 coverage.mask 는 보내지 않는다(조각에 없음): 영상 밖 픽셀은 rgb 0 으로 오며 이는 알려진 한계다.
const MESH_HEADER_BYTES = 16;
const DRAPE_HEADER_BYTES = 16;

function serializeMeshPiece(mesh, tx, ty) {
  const buf = Buffer.alloc(PIECE_FRAME_OVERHEAD_BYTES + MESH_HEADER_BYTES + mesh.positions.byteLength + mesh.indices.byteLength);
  let o = PIECE_FRAME_OVERHEAD_BYTES; // 프레임 머리 영역은 0 으로 비워 두고 길이만 센다
  o = buf.writeUInt32LE(mesh.positions.length / 3, o);
  o = buf.writeUInt32LE(mesh.indices.length, o);
  o = buf.writeInt32LE(tx, o);
  o = buf.writeInt32LE(ty, o);
  Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength).copy(buf, o);
  o += mesh.positions.byteLength;
  Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength).copy(buf, o);
  return buf;
}

function serializeDrapePiece(tile) {
  const buf = Buffer.alloc(PIECE_FRAME_OVERHEAD_BYTES + DRAPE_HEADER_BYTES + tile.rgb.byteLength);
  let o = PIECE_FRAME_OVERHEAD_BYTES;
  o = buf.writeInt32LE(tile.tx, o);
  o = buf.writeInt32LE(tile.ty, o);
  o = buf.writeUInt16LE(tile.width, o);
  o = buf.writeUInt16LE(tile.height, o);
  o = buf.writeUInt8(tile.mip, o);
  o += 3;
  Buffer.from(tile.rgb.buffer, tile.rgb.byteOffset, tile.rgb.byteLength).copy(buf, o);
  return buf;
}

/** 관제탑 범위 타일 번호(-8..7). */
function towerTiles() {
  const out = [];
  const lo = -TOWER_TILES_PER_SIDE / 2;
  for (let ty = lo; ty < lo + TOWER_TILES_PER_SIDE; ty++) {
    for (let tx = lo; tx < lo + TOWER_TILES_PER_SIDE; tx++) out.push([tx, ty]);
  }
  return out;
}

/** DEM 하나의 LOD 별 전체 타일 직렬화 크기·시간. */
function measureTerrainAll(dem) {
  const tiles = towerTiles();
  const size = {};
  const timings = {};
  const cells = {};
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    const t0 = process.hrtime.bigint();
    let bytes = 0;
    for (const [tx, ty] of tiles) {
      const tile = buildTerrainTile(dem, tx, ty, lod);
      cells[lod] = tile.cells;
      bytes += serializeMeshPiece(terrainTileToMesh(tile), tx, ty).byteLength;
    }
    timings[lod] = Number(process.hrtime.bigint() - t0) / 1e6;
    size[lod] = bytes;
  }
  return { tileCount: tiles.length, size, timings, cells };
}

/** 드레이프 밉 단계별 전체 타일 직렬화 크기. */
function measureDrapeAll(image) {
  const tiles = towerTiles();
  const size = {};
  const timings = {};
  for (let mip = 0; mip < DRAPE_MIP_COUNT; mip++) {
    const t0 = process.hrtime.bigint();
    let bytes = 0;
    for (const [tx, ty] of tiles) bytes += serializeDrapePiece(buildDrapeTile(image, tx, ty, mip)).byteLength;
    timings[mip] = Number(process.hrtime.bigint() - t0) / 1e6;
    size[mip] = bytes;
  }
  return { tileCount: tiles.length, size, timings };
}

/**
 * 벤치마크 실행: 건물 6,191동 + 지형 처리 성능·크기 측정
 * @returns {{
 *   buildings: { count: number, timings: { extrude: number, lod500m: number, lod5km: number }, size: { vertices: number, indices: number, total: number } },
 *   terrain: { timings: { [lod: number]: number }, size: { [lod: number]: number } },
 *   totalSize: number
 * }}
 */
export function measureTowerAssets() {
  const seed = 42; // 고정 시드

  const footprints = generateFootprints(seed);
  const dem = generateDem(seed);

  const result = {
    buildings: {
      count: CITY_COUNT,
      timings: {},
      size: { vertices: 0, indices: 0, total: 0, serialized: 0 },
    },
    terrain: null,
    smoothTerrain: null,
    drape: null,
    limitBytes: INITIAL_LIMIT_BYTES,
    initial: { terrainLod: INITIAL_TERRAIN_LOD, drapeMip: INITIAL_DRAPE_MIP },
    breakdown: null,
    totalSize: 0,
    breakdownMip0: null,
    totalSizeMip0: 0,
    exceeds: false,
    overBytes: 0,
    exceedsMip0: false,
    overBytesMip0: 0,
  };

  // ==================== 건물 처리 ====================

  // extrudeAll
  let t0 = process.hrtime.bigint();
  const extruded = extrudeAll(footprints);
  let t1 = process.hrtime.bigint();
  result.buildings.timings.extrude = Number(t1 - t0) / 1e6; // ms
  console.log(`[buildings] extrudeAll: ${result.buildings.timings.extrude.toFixed(2)} ms`);

  // 정점·인덱스 크기 합산
  let totalVerts = 0, totalIndices = 0;
  for (const b of extruded) {
    if (b.mesh) {
      totalVerts += (b.mesh.positions?.length ?? 0) / 3;
      totalIndices += b.mesh.indices?.length ?? 0;
    }
  }
  result.buildings.size.vertices = totalVerts * 12; // 4 float × 3 = 12B
  result.buildings.size.indices = totalIndices * 4; // uint32 = 4B
  result.buildings.size.total = result.buildings.size.vertices + result.buildings.size.indices;
  console.log(`[buildings] size: ${(result.buildings.size.total / 1e6).toFixed(2)} MB`);

  // LOD 500m
  t0 = process.hrtime.bigint();
  const lod500 = buildBuildingLod(extruded, 500); // BUILDING_LOD_FAR_DIST_M = 500
  t1 = process.hrtime.bigint();
  result.buildings.timings.lod500m = Number(t1 - t0) / 1e6;
  console.log(`[buildings] buildBuildingLod(500m): ${result.buildings.timings.lod500m.toFixed(2)} ms`);

  // LOD 5km
  t0 = process.hrtime.bigint();
  const lod5km = buildBuildingLod(extruded, 5000);
  t1 = process.hrtime.bigint();
  result.buildings.timings.lod5km = Number(t1 - t0) / 1e6;
  console.log(`[buildings] buildBuildingLod(5km): ${result.buildings.timings.lod5km.toFixed(2)} ms`);

  // 건물 직렬화 크기(건물 한 동 = 조각 하나)
  let serialized = 0;
  for (const b of extruded) {
    if (b.mesh) serialized += serializeMeshPiece(b.mesh, 0, 0).byteLength;
  }
  result.buildings.size.serialized = serialized;
  console.log(`[buildings] serialized: ${(serialized / 1e6).toFixed(2)} MB`);

  // ==================== 지형·드레이프 (관제탑 범위 전체 타일) ====================

  result.terrain = measureTerrainAll(dem);
  result.smoothTerrain = measureTerrainAll(generateSmoothDem());
  result.drape = measureDrapeAll(generateImage());
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    console.log(`[terrain] LOD${lod}: noisy ${result.terrain.size[lod]} B, smooth ${result.smoothTerrain.size[lod]} B (cells ${result.smoothTerrain.cells[lod]})`);
  }
  for (let mip = 0; mip < DRAPE_MIP_COUNT; mip++) console.log(`[drape] mip${mip}: ${result.drape.size[mip]} B`);

  // 크기 내역(초기 = 지형 LOD INITIAL_TERRAIN_LOD + 드레이프 밉 INITIAL_DRAPE_MIP) 과 밉0 비교.
  const buildingsBytes = result.buildings.size.serialized;
  const terrainBytes = result.terrain.size[INITIAL_TERRAIN_LOD];
  result.breakdown = { buildings: buildingsBytes, terrain: terrainBytes, drape: result.drape.size[INITIAL_DRAPE_MIP] };
  result.breakdownMip0 = { buildings: buildingsBytes, terrain: terrainBytes, drape: result.drape.size[0] };
  result.totalSize = result.breakdown.buildings + result.breakdown.terrain + result.breakdown.drape;
  result.totalSizeMip0 = result.breakdownMip0.buildings + result.breakdownMip0.terrain + result.breakdownMip0.drape;
  // 상한은 바꾸지 않고, 넘으면 넘는 대로 기록한다.
  result.exceeds = result.totalSize > INITIAL_LIMIT_BYTES;
  result.overBytes = Math.max(0, result.totalSize - INITIAL_LIMIT_BYTES);
  result.exceedsMip0 = result.totalSizeMip0 > INITIAL_LIMIT_BYTES;
  result.overBytesMip0 = Math.max(0, result.totalSizeMip0 - INITIAL_LIMIT_BYTES);

  console.log(`\n[TOTAL initial] ${result.totalSize} B (limit ${INITIAL_LIMIT_BYTES}, exceeds ${result.exceeds}, over ${result.overBytes})`);
  console.log(`[TOTAL mip0] ${result.totalSizeMip0} B (exceeds ${result.exceedsMip0}, over ${result.overBytesMip0})`);
  return result;
}
