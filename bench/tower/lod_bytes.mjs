// T15.10 지형 LOD 단계별 타일 바이트 측정(결정 0046 T15.1c: LOD3 상한 1 m 의 대가 확인).
// 합성 DEM(완만한 언덕, 거친 잡음 noiseBig 류) 각각에서 관제탑 범위 256 타일의 LOD0~LOD3 직렬화 바이트(raw·gzip -9)와
// LOD3/LOD2, LOD3/LOD0 비율을 낸다. 직렬화는 bench/tower_assets 의 메시 조각 배치(프레임 머리 + 조각 머리 16 B + positions + indices)와 같다.
// 판정은 값만 보고하며 문턱으로 던지지 않는다: LOD3 >= LOD2 바이트(reopen0046)이거나 LOD3 합이 초기 상한을 넘으면(overBudget) 표시한다.
// 실행: node bench/tower/lod_bytes.mjs
import { gzipSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildTerrainTile, terrainTileToMesh } from '../../server/terrain/mesh_lod/index.mjs';
import { PIECE_FRAME_OVERHEAD_BYTES } from '../../server/scheduler/initial/index.mjs';
import { TERRAIN_LOD_COUNT, TERRAIN_LOD_MAX_ERROR_M } from '../../contracts/tower_assets/index.mjs';
import { INITIAL_LIMIT_BYTES } from '../tower_assets/index.mjs';

const SPAN_M = 1024;
const TILES_PER_SIDE = SPAN_M / 64;
const MESH_HEADER_BYTES = 16;

/** 정수 해시 잡음 ∈ [−0.5, 0.5] (초월함수 없음, server/terrain/mesh_lod 시험의 hashNoise 와 같은 식 + 시드). */
function hashNoise(i, j, seed = 0) {
  let x = ((i + seed * 31) * 73856093) ^ (j * 19349663);
  x = Math.imul(x ^ (x >>> 13), 0x5bd1e995);
  x ^= x >>> 15;
  return ((x >>> 0) % 1001) / 1000 - 0.5;
}

function makeDem(f) {
  const side = SPAN_M + 1;
  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) heights[j * side + i] = f(i - SPAN_M / 2, j - SPAN_M / 2, i, j);
  return { originX: -SPAN_M / 2, originY: -SPAN_M / 2, cellM: 1, width: side, height: side, heights };
}

/** 완만한 DEM: bench/tower_assets 의 generateSmoothDem 과 같은 식(진폭 25 m, 파장 수백 m). */
export function smoothDem() {
  const dem = makeDem((x, y) => 20 + 25 * Math.sin(x / 300) * Math.cos(y / 400));
  dem.__cacheKey = 'smooth';
  return dem;
}
/** 거친 DEM: mesh_lod 시험의 noiseBig 와 같은 식(폭 ±1 m 화소 잡음). */
export function noiseBigDem(seed = 0) {
  const dem = makeDem((x, y, i, j) => 2 * hashNoise(i, j, seed));
  dem.__cacheKey = `noiseBig:${seed}`;
  return dem;
}

function serializeMeshPiece(mesh, tx, ty) {
  const buf = Buffer.alloc(PIECE_FRAME_OVERHEAD_BYTES + MESH_HEADER_BYTES + mesh.positions.byteLength + mesh.indices.byteLength);
  let o = PIECE_FRAME_OVERHEAD_BYTES;
  o = buf.writeUInt32LE(mesh.positions.length / 3, o);
  o = buf.writeUInt32LE(mesh.indices.length, o);
  o = buf.writeInt32LE(tx, o);
  o = buf.writeInt32LE(ty, o);
  Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength).copy(buf, o);
  o += mesh.positions.byteLength;
  Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength).copy(buf, o);
  return buf;
}

// Module-level cache for memoization
const __measureLodBytesCache = {};

/**
 * DEM 하나의 LOD 별 256 타일 합계.
 * @returns {{levels: {lod:number, cells:number, rawBytes:number, gzipBytes:number}[], ratios:Object, ...}}
 */
export function measureLodBytes(dem) {
  // Check cache if DEM has a cache key
  if (dem.__cacheKey && __measureLodBytesCache[dem.__cacheKey]) {
    return __measureLodBytesCache[dem.__cacheKey];
  }

  const levels = [];
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    let rawBytes = 0, gzipBytes = 0, cells = 0, tiles = 0;
    for (let ty = -TILES_PER_SIDE / 2; ty < TILES_PER_SIDE / 2; ty++) {
      for (let tx = -TILES_PER_SIDE / 2; tx < TILES_PER_SIDE / 2; tx++) {
        const tile = buildTerrainTile(dem, tx, ty, lod);
        cells = tile.cells;
        const buf = serializeMeshPiece(terrainTileToMesh(tile), tx, ty);
        rawBytes += buf.length;
        gzipBytes += gzipSync(buf, { level: 9 }).length; // 타일(조각)마다 따로 압축
        tiles++;
      }
    }
    levels.push({ lod, cells, tiles, rawBytes, gzipBytes });
  }
  const [l0, , l2, l3] = levels;
  const ratios = {
    lod3OverLod2: { raw: l3.rawBytes / l2.rawBytes, gzip: l3.gzipBytes / l2.gzipBytes },
    lod3OverLod0: { raw: l3.rawBytes / l0.rawBytes, gzip: l3.gzipBytes / l0.gzipBytes },
  };
  const result = {
    levels,
    ratios,
    // 0046 다시 볼 조건: LOD3 바이트가 LOD2 와 같거나 크다.
    lod3NotSmallerThanLod2: l3.rawBytes >= l2.rawBytes,
    // LOD3 만 보낸 지형 합이 초기 상한(SPEC S6 초기 ≤ 15 MB, bench/tower_assets INITIAL_LIMIT_BYTES)을 넘는다(raw 기준·gzip 기준).
    lod3OverBudgetRaw: l3.rawBytes > INITIAL_LIMIT_BYTES,
    lod3OverBudgetGzip: l3.gzipBytes > INITIAL_LIMIT_BYTES,
  };

  // Cache the result if DEM has a cache key
  if (dem.__cacheKey) {
    __measureLodBytesCache[dem.__cacheKey] = result;
  }

  return result;
}

export function measureAll() {
  return {
    maxErrorM: [...TERRAIN_LOD_MAX_ERROR_M],
    limitBytes: INITIAL_LIMIT_BYTES,
    tilesPerRun: TILES_PER_SIDE * TILES_PER_SIDE,
    dems: { smooth: measureLodBytes(smoothDem()), noiseBig: measureLodBytes(noiseBigDem(0)) },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(measureAll(), null, 2));
}
