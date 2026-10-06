// T15.10b-B3: F-458 비교안 (iv) — LOD3 정점 수 상한 / 타일별 간격. 서버 코드(server/terrain/mesh_lod)는 고치지 않고
// 필요한 규칙을 이 파일에 복사해 변형한다. 측정 전용(bench), 제품 경로에서 가져오지 않는다.
//
// 변형(측정 전에 정한 정의)
// - baseline: 제품 규칙 그대로(DEM 하나·LOD 하나에 전역 간격, 오차 상한 TERRAIN_LOD_MAX_ERROR_M = [0,0.5,1,1] 을 모든 타일이 만족하는
//   가장 큰 간격). 서버 terrainLodStride 를 직접 부른다.
// - cap(N): LOD 0~2 는 baseline. LOD 3 만, 타일당 정점 수 (n0/s+1)² 가 N 을 넘으면 간격 s 를 2 배씩 키운다(오차 상한 포기).
//   간격은 여전히 DEM 전체에 하나(전역)라 같은 LOD 이웃 사이 T 접합 균열은 생기지 않는다.
// - perTile: LOD 1~3 에서 타일마다 자기 오차만 보고 간격을 고른다(명목 간격에서 시작해 상한을 넘으면 절반). 이웃과 간격이 다르면
//   공유 변에서 가는 쪽은 DEM 표본, 굵은 쪽은 선형 보간이라 T 접합 균열이 생긴다(mesh_lod 헤더 주석). 고치지 않고 그대로 잰다.
// - perTileSnap: perTile 과 같은 간격에, 가는 쪽 타일의 공유 변 정점 높이를 굵은 이웃의 변 선형 보간값으로 바꾼다(같은 LOD 이웃끼리).
//   기하적으로 틈이 닫히지만(위상은 T 접합 그대로) 가는 쪽 타일의 변에서 오차 상한이 깨질 수 있다(mesh_lod 헤더가 지적한 대가).
//
// 좌표·대각선 규약·오차 정의는 server/terrain/mesh_lod/index.mjs 와 같다(오차 = 메시 표면 대 DEM 메시, DEM 표본점에서 최대).
import { TERRAIN_TILE_SIZE_M, TERRAIN_LOD_COUNT, TERRAIN_LOD_MAX_ERROR_M } from '../../../contracts/tower_assets/index.mjs';
import { terrainLodStride } from '../../../server/terrain/mesh_lod/index.mjs';
import { PIECE_FRAME_OVERHEAD_BYTES } from '../../../server/scheduler/initial/index.mjs';

const ALIGN_EPS = 1e-6;
const MESH_HEADER_BYTES = 16; // bench/tower/lod_bytes.mjs 의 조각 머리와 같다

function nearInt(v) {
  const r = Math.round(v);
  return Math.abs(v - r) <= ALIGN_EPS ? r : null;
}

/** DEM 이 덮는 타일 목록과 n0(타일 한 변 DEM 셀 수). 서버 coveredTileOrigins 의 사본(결측 타일 없음을 가정하고 검사). */
export function demTiles(dem) {
  const n0 = nearInt(TERRAIN_TILE_SIZE_M / dem.cellM);
  if (n0 === null || n0 < 1) throw new Error('타일 한 변이 cellM 의 정수배가 아니다');
  const t = TERRAIN_TILE_SIZE_M;
  const txMin = Math.ceil(dem.originX / t - ALIGN_EPS) + 0;
  const tyMin = Math.ceil(dem.originY / t - ALIGN_EPS) + 0;
  const tiles = [];
  for (let ty = tyMin; ; ty++) {
    const j0 = nearInt((ty * t - dem.originY) / dem.cellM);
    if (j0 === null || j0 + n0 > dem.height - 1) break;
    for (let tx = txMin; ; tx++) {
      const i0 = nearInt((tx * t - dem.originX) / dem.cellM);
      if (i0 === null || i0 + n0 > dem.width - 1) break;
      tiles.push({ i0, j0, tx, ty });
    }
  }
  for (const h of dem.heights) if (!Number.isFinite(h)) throw new Error('결측 높이가 있는 DEM 은 이 측정 범위 밖');
  const byKey = new Map(tiles.map((tl) => [`${tl.tx},${tl.ty}`, tl]));
  return { n0, tiles, byKey };
}

/** 서버 nominalStride 사본: n0 를 나누는 2 의 거듭제곱 가운데 2^lod 이하 최댓값. */
export function nominalStride(n0, lod) {
  let s = 1;
  while (s < (1 << lod) && n0 % (s * 2) === 0) s *= 2;
  return s;
}

/** 서버 gridError 사본: 격자 z(ci,cj)(타일 정점 번호)의 삼각형 메시 표면과 DEM 표본의 최대 차이. */
export function gridError(dem, i0, j0, n0, stride, z) {
  const n = n0 / stride;
  const w = dem.width;
  const h = dem.heights;
  let max = 0;
  for (let j = 0; j <= n0; j++) {
    const cj = Math.min(Math.floor(j / stride), n - 1);
    const fy = (j - cj * stride) / stride;
    for (let i = 0; i <= n0; i++) {
      const ci = Math.min(Math.floor(i / stride), n - 1);
      const fx = (i - ci * stride) / stride;
      const z00 = z(ci, cj), z11 = z(ci + 1, cj + 1);
      const v = fx >= fy
        ? z00 + fx * (z(ci + 1, cj) - z00) + fy * (z11 - z(ci + 1, cj))
        : z00 + fy * (z(ci, cj + 1) - z00) + fx * (z11 - z(ci, cj + 1));
      const e = Math.abs(v - h[(j0 + j) * w + (i0 + i)]);
      if (e > max) max = e;
    }
  }
  return max;
}

function strideError(dem, tl, n0, stride) {
  if (stride === 1) return 0;
  const w = dem.width, h = dem.heights;
  return gridError(dem, tl.i0, tl.j0, n0, stride, (ci, cj) => h[(tl.j0 + cj * stride) * w + tl.i0 + ci * stride]);
}

/** 제품 규칙의 사본(전역 간격). 서버 terrainLodStride 와 같은지 측정 스크립트가 대조한다. */
export function globalStrideCopy(dem, lod) {
  const { n0, tiles } = demTiles(dem);
  const limit = TERRAIN_LOD_MAX_ERROR_M[lod];
  let s = nominalStride(n0, lod);
  while (s > 1 && tiles.some((tl) => strideError(dem, tl, n0, s) > limit)) s /= 2;
  return s;
}

/** 타일 하나만 보고 고른 간격(perTile). 명목 간격에서 시작해 이 타일의 오차가 상한을 넘으면 절반. */
export function tileStride(dem, tl, n0, lod) {
  const limit = TERRAIN_LOD_MAX_ERROR_M[lod];
  let s = nominalStride(n0, lod);
  while (s > 1 && strideError(dem, tl, n0, s) > limit) s /= 2;
  return s;
}

/** 정점 수 상한 N 을 지키는 가장 작은 간격(n0 를 나누는 2 의 거듭제곱). 상한이 타일 하나(2×2 정점)보다 작으면 n0. */
export function capStride(n0, capVertices) {
  let s = 1;
  while ((n0 / s + 1) ** 2 > capVertices && s < n0 && n0 % (s * 2) === 0) s *= 2;
  return s;
}

/** 한 변 정점 수 cells 인 타일 조각의 raw 바이트: 메시 형식(f32 xyz + u32 인덱스, lod_bytes.mjs 와 같은 직렬화 길이). */
export function meshTileBytes(cells) {
  return PIECE_FRAME_OVERHEAD_BYTES + MESH_HEADER_BYTES + cells * cells * 12 + (cells - 1) * (cells - 1) * 6 * 4;
}
/** 높이만 형식(f32 cells², xy·인덱스는 격자에서 복원, 조각 머리 같음) — lod_bytes.mjs heightOnlyBytes 와 같은 식. */
export function heightTileBytes(cells) {
  return PIECE_FRAME_OVERHEAD_BYTES + MESH_HEADER_BYTES + cells * cells * 4;
}

/**
 * 변형 정의. strides(dem, ctx, lod) → Map('tx,ty' → 간격). snap 이면 가는 쪽 변을 굵은 이웃 변에 맞춘다.
 * capVertices 는 측정 전에 정한다(b3_measure.mjs 머리 주석).
 */
export function makeVariants({ budgetCapVertices }) {
  const globalMap = (dem, ctx, s) => new Map(ctx.tiles.map((tl) => [`${tl.tx},${tl.ty}`, s]));
  const baseline = (dem, ctx, lod) => globalMap(dem, ctx, terrainLodStride(dem, lod));
  const cap = (N) => (dem, ctx, lod) => {
    const s = terrainLodStride(dem, lod);
    return globalMap(dem, ctx, lod === TERRAIN_LOD_COUNT - 1 ? Math.max(s, capStride(ctx.n0, N)) : s);
  };
  const perTile = (dem, ctx, lod) => new Map(ctx.tiles.map((tl) => [`${tl.tx},${tl.ty}`, lod === 0 ? 1 : tileStride(dem, tl, ctx.n0, lod)]));
  return [
    { name: 'baseline', label: '현행 [0,0.5,1,1] 전역 간격', strides: baseline, snap: false },
    { name: `cap${budgetCapVertices}`, label: `LOD3 정점 상한 ${budgetCapVertices}(예산 유도, 메시 형식)`, strides: cap(budgetCapVertices), snap: false },
    { name: 'cap289', label: 'LOD3 정점 상한 289(17², 1 m DEM 에서 4 m)', strides: cap(289), snap: false },
    { name: 'cap81', label: 'LOD3 정점 상한 81(9², 1 m DEM 명목 LOD3 8 m)', strides: cap(81), snap: false },
    { name: 'perTile', label: '타일별 간격(봉합 없음)', strides: perTile, snap: false },
    { name: 'perTileSnap', label: '타일별 간격 + 가는 쪽 변을 굵은 이웃 보간값으로', strides: perTile, snap: true },
  ];
}

/**
 * 한 변형·한 LOD 의 타일들을 만든다. which = 만들 타일 키 목록(없으면 전부). 이웃 정보는 DEM 전체에서 본다.
 * @returns {{ tiles: Array<{tx,ty,lod,cells,heights:Float32Array}>, strideMap: Map }}
 */
export function buildVariantTiles(dem, ctx, variant, lod, which = null) {
  const strideMap = variant.strides(dem, ctx, lod);
  const w = dem.width, H = dem.heights, n0 = ctx.n0;
  const list = which ? which.map((k) => ctx.byKey.get(k)) : ctx.tiles;
  const tiles = list.map((tl) => {
    const s = strideMap.get(`${tl.tx},${tl.ty}`);
    const c = n0 / s + 1;
    const out = new Float32Array(c * c);
    for (let j = 0; j < c; j++) for (let i = 0; i < c; i++) out[j * c + i] = H[(tl.j0 + j * s) * w + tl.i0 + i * s];
    if (variant.snap) {
      // 변마다 이웃 간격 sN 이 더 굵으면 그 변 정점을 이웃의 변 선형 보간값으로 바꾼다(모서리는 두 격자에 모두 있어 그대로).
      const edges = [
        { nb: `${tl.tx},${tl.ty - 1}`, at: (k) => [k, 0] },
        { nb: `${tl.tx},${tl.ty + 1}`, at: (k) => [k, c - 1] },
        { nb: `${tl.tx - 1},${tl.ty}`, at: (k) => [0, k] },
        { nb: `${tl.tx + 1},${tl.ty}`, at: (k) => [c - 1, k] },
      ];
      for (const e of edges) {
        const sN = strideMap.get(e.nb);
        if (sN === undefined || sN <= s) continue;
        for (let k = 0; k < c; k++) {
          const [i, j] = e.at(k);
          // 변 위 DEM 셀 위치 d(0..n0), 굵은 쪽 칸 번호와 비율
          const d = k * s;
          const seg = Math.min(Math.floor(d / sN), n0 / sN - 1);
          const f = (d - seg * sN) / sN;
          const ia = (iA, jA) => H[(tl.j0 + jA) * w + tl.i0 + iA];
          let za, zb;
          if (e.at(0)[1] === e.at(1)[1]) { // 가로 변(j 고정)
            const jj = j * s;
            za = ia(seg * sN, jj); zb = ia((seg + 1) * sN, jj);
          } else { // 세로 변(i 고정)
            const ii = i * s;
            za = ia(ii, seg * sN); zb = ia(ii, (seg + 1) * sN);
          }
          out[j * c + i] = za + f * (zb - za);
        }
      }
    }
    return { tx: tl.tx, ty: tl.ty, lod, cells: c, heights: out };
  });
  return { tiles, strideMap };
}

/** 타일 하나의 메시 오차(서버 measureTerrainError 와 같은 정의). */
export function tileError(dem, ctx, tile) {
  const tl = ctx.byKey.get(`${tile.tx},${tile.ty}`);
  const c = tile.cells;
  return gridError(dem, tl.i0, tl.j0, ctx.n0, ctx.n0 / (c - 1), (ci, cj) => tile.heights[cj * c + ci]);
}

/**
 * 같은 LOD 이웃 타일 사이 공유 변의 틈. 각 쪽 변 함수 = 그 타일 변 정점 높이의 선형 보간(삼각형 변이 곧 타일 변이다).
 * 변 위 DEM 표본점마다 |두 쪽 차이| 를 잰다(두 쪽 모두 구간 선형이고 꺾임점이 DEM 표본 위에 있으므로 그 최대가 변 전체 최대).
 * @returns {{ edges, mismatchedEdges, crackEdges, maxGapM, crackLengthM }}
 *   mismatchedEdges = 간격이 다른 변 수, crackEdges = 틈 > 1e-4 m 인 변 수, crackLengthM = 틈 > 1e-4 m 인 DEM 셀 구간 길이 합(근사).
 */
export function crackStats(dem, ctx, tiles) {
  const byKey = new Map(tiles.map((t) => [`${t.tx},${t.ty}`, t]));
  const n0 = ctx.n0;
  const edgeVal = (t, side, d) => {
    const c = t.cells, s = n0 / (c - 1);
    const seg = Math.min(Math.floor(d / s), c - 2);
    const f = (d - seg * s) / s;
    const v = (k) => (side === 'top' ? t.heights[(c - 1) * c + k] : t.heights[k * c + (c - 1)]); // top: j=c-1 행, right: i=c-1 열
    return v(seg) + f * (v(seg + 1) - v(seg));
  };
  const edgeValOther = (t, side, d) => {
    const c = t.cells, s = n0 / (c - 1);
    const seg = Math.min(Math.floor(d / s), c - 2);
    const f = (d - seg * s) / s;
    const v = (k) => (side === 'bottom' ? t.heights[k] : t.heights[k * c]); // bottom: j=0 행, left: i=0 열
    return v(seg) + f * (v(seg + 1) - v(seg));
  };
  let edges = 0, mismatched = 0, crackEdges = 0, maxGap = 0, crackCells = 0;
  for (const t of tiles) {
    for (const [dx, dy, mine, theirs] of [[0, 1, 'top', 'bottom'], [1, 0, 'right', 'left']]) {
      const o = byKey.get(`${t.tx + dx},${t.ty + dy}`);
      if (!o) continue;
      edges++;
      if (o.cells !== t.cells) mismatched++;
      let eMax = 0;
      let prevBad = false;
      for (let d = 0; d <= n0; d++) {
        const g = Math.abs(edgeVal(t, mine, d) - edgeValOther(o, theirs, d));
        if (g > eMax) eMax = g;
        const bad = g > 1e-4;
        if (bad && d > 0) crackCells++;
        else if (prevBad && d > 0) crackCells++;
        prevBad = bad;
      }
      if (eMax > 1e-4) crackEdges++;
      if (eMax > maxGap) maxGap = eMax;
    }
  }
  return { edges, mismatchedEdges: mismatched, crackEdges, maxGapM: maxGap, crackLengthM: crackCells * dem.cellM };
}
