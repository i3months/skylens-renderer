// [cloud] 합성 DEM 측정(실제 DEM T14L 은 [local] 미측정, WS 실측은 T16 이월).
// T15.10 지형 LOD 단계별 타일 바이트 측정(결정 0046 T15.1c: LOD3 상한 1 m 의 대가 확인).
// 합성 DEM(완만한 언덕, 거친 잡음 noiseBig 류) 각각에서 관제탑 범위 256 타일의 LOD0~LOD3 직렬화 바이트(raw·gzip -9)와
// LOD3/LOD2, LOD3/LOD0 비율을 낸다. 직렬화는 bench/tower_assets 의 메시 조각 배치(프레임 머리 + 조각 머리 16 B + positions + indices)와 같다.
// 판정은 값만 보고하며 문턱으로 던지지 않는다: LOD3 >= LOD2 바이트(reopen0046)이거나 LOD3 합이 초기 상한을 넘으면(overBudget) 표시한다.
// 형식 가정: 지형 전송 형식 계약이 아직 없다. rawBytes/gzipBytes 는 인덱스 + xy 포함 메시 형식(f32 xyz + u32 인덱스)을 가정한 값이고,
//   heightOnlyBytes 는 타일마다 높이(f32 cells²)만 보내는 형식(xy·인덱스는 격자에서 복원)의 값이다. 형식 선택 하나로 수치가 크게 달라진다
//   (noiseBig LOD3 raw: 메시 형식 약 38.16 MB, 높이만 약 4.34 MB).
// 범위: 지형 단독, 시야 선택 없음(256 타일 전부). SPEC 의 '초기'(접속~첫 프레임 웹소켓 바이트 전체)와 다르다. 건물·드레이프가 같은 예산을 쓰므로
//   초기 합계 PASS/FAIL 은 bench/tower_assets 의 합계로 본다.
// gzip 은 참고값이다: 서버 ws 는 permessage-deflate 가 없다(server/ws/frame/index.mjs:197 에서 RSV 거부). 판정은 raw 로 한다.
// ws 머리 10 B(WS_HEADER_MAX_BYTES)는 상한이라, 조각 프레임이 64 KiB 미만일 때만(ws 머리가 4 B 로 줄어드는 구간) 실제보다 약 6 B 과대하다.
//   64 KiB 이상 조각(noiseBig LOD3 의 약 149 KB 메시 조각 등)은 상한이 실제와 같아 과대 0 이다.
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

/** 측정 캐시를 비운다. 결정성 시험이 캐시를 우회해 독립 계산 두 번을 비교할 때 쓴다. */
export function clearLodBytesCache() {
  for (const k of Object.keys(__measureLodBytesCache)) delete __measureLodBytesCache[k];
}

/**
 * DEM 하나의 LOD 별 256 타일 합계.
 * @returns {{levels: {lod:number, cells:number, rawBytes:number, gzipBytes:number}[], ratios:Object, ...}}
 */
export function measureLodBytes(dem, { tilesPerSide = TILES_PER_SIDE } = {}) {
  // tilesPerSide: 가운데 tilesPerSide x tilesPerSide 타일만 잰다(기본 16 = 256 타일 전부, 작게 주면 시험이 빨라진다).
  const cacheKey = dem.__cacheKey ? `${dem.__cacheKey}|${tilesPerSide}` : null;
  if (cacheKey && __measureLodBytesCache[cacheKey]) {
    return __measureLodBytesCache[cacheKey];
  }

  const levels = [];
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    let rawBytes = 0, gzipBytes = 0, heightOnlyBytes = 0, cells = 0, tiles = 0;
    for (let ty = -tilesPerSide / 2; ty < tilesPerSide / 2; ty++) {
      for (let tx = -tilesPerSide / 2; tx < tilesPerSide / 2; tx++) {
        const tile = buildTerrainTile(dem, tx, ty, lod);
        cells = tile.cells;
        const buf = serializeMeshPiece(terrainTileToMesh(tile), tx, ty);
        rawBytes += buf.length;
        gzipBytes += gzipSync(buf, { level: 9 }).length; // 참고값: 타일(조각)마다 따로 압축, ws 에는 압축이 없다
        heightOnlyBytes += PIECE_FRAME_OVERHEAD_BYTES + MESH_HEADER_BYTES + tile.heights.byteLength; // 높이만 형식(조각 머리 같음)
        tiles++;
      }
    }
    levels.push({ lod, cells, tiles, rawBytes, gzipBytes, heightOnlyBytes });
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
  if (cacheKey) {
    __measureLodBytesCache[cacheKey] = result;
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
