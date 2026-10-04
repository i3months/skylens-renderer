// T14 관제탑 자산 벤치마크: 합성 도시 6,191동 처리 성능·크기 측정.
// 외부 의존성 없음, 결정적 PRNG 시드 고정.

import { mulberry32, subSeed } from '../../contracts/scenes/index.mjs';
import { extrudeAll } from '../../server/buildings/extrude/index.mjs';
import { buildBuildingLod } from '../../server/buildings/lod/index.mjs';
import { buildTerrainTile } from '../../server/terrain/mesh_lod/index.mjs';

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
  const size = 1000; // 1 km = 1000 m
  const cell = 1; // 1 m cells
  const side = size / cell; // 1000
  const rnd = mulberry32(subSeed(seed, 999));

  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      // 간단한 합성 높이: 기본값 ≈ 10m + 약간의 변동
      heights[j * side + i] = 10 + rnd() * 5;
    }
  }

  return {
    originX: -500,
    originY: -500,
    cellM: cell,
    width: side,
    height: side,
    heights,
  };
}

/**
 * Mesh 크기 계산 (정점 f32 12B + 인덱스 u32 4B)
 */
function meshSize(mesh) {
  if (!mesh) return 0;
  const vertexBytes = (mesh.positions?.length ?? 0) * 4; // Float32
  const indexBytes = (mesh.indices?.length ?? 0) * 4; // Uint32
  return vertexBytes + indexBytes;
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
      size: { vertices: 0, indices: 0, total: 0 },
    },
    terrain: {
      timings: {},
      size: {},
    },
    totalSize: 0,
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

  // ==================== 지형 처리 ====================

  for (let lod = 0; lod < 4; lod++) {
    t0 = process.hrtime.bigint();
    const tile = buildTerrainTile(dem, 0, 0, lod);
    t1 = process.hrtime.bigint();
    result.terrain.timings[lod] = Number(t1 - t0) / 1e6;
    console.log(`[terrain] buildTerrainTile(LOD${lod}): ${result.terrain.timings[lod].toFixed(2)} ms`);

    // 크기 계산 (heights Float32Array)
    const heightsSize = (tile.heights?.length ?? 0) * 4;
    result.terrain.size[lod] = heightsSize;
    console.log(`[terrain] LOD${lod} size: ${(heightsSize / 1024).toFixed(1)} KB`);
  }

  // 총 크기
  result.totalSize = result.buildings.size.total;
  for (let lod = 0; lod < 4; lod++) {
    result.totalSize += result.terrain.size[lod];
  }

  console.log(`\n[TOTAL] ${(result.totalSize / 1e6).toFixed(2)} MB`);
  return result;
}
