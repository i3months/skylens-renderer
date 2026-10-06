// T14.1 지형 메시 LOD. DEM → 64 m 타일의 LOD 0..3 정규 격자.
// 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m, X 동·Y 북·Z 위. 외부 의존성 없음.
//
// 설계 요약
// - LOD 0 = 원본 DEM 격자 그대로(정점 = DEM 표본, 오차 0). DEM 격자는 타일 경계에 맞아야 한다
//   (64 / cellM 이 정수, 타일 경계가 DEM 표본 위에 놓임). 맞지 않으면 TowerAssetError.
// - LOD k 의 명목 간격(stride, DEM 셀 단위)은 2^k. 정점 높이는 DEM 표본을 그대로 옮긴다(부분 표본).
//   그래서 가장자리 정점은 이웃 타일과 같은 DEM 표본을 공유하고, 높이가 바이트 단위로 같다.
// - 오차는 그려지는 표면(메시) 기준으로 잰다(F-305). 타일 표면 = terrainTileToMesh 와 같은 대각선
//   규약((i,j)–(i+1,j+1))의 삼각형 보간, 기준 표면 = 원본 DEM 을 같은 규약으로 나눈 삼각형 메시(= LOD 0 메시).
//   타일 칸의 대각선은 DEM 셀 대각선을 따라 DEM 표본을 지나고, 칸 변은 DEM 격자선 위에 있으므로
//   DEM 의 작은 삼각형 하나는 타일의 큰 삼각형 하나 안에 통째로 들어간다. 그 안에서 차이는 선형이라
//   절댓값 최대는 DEM 표본점(칸 대각선 위 표본 포함)에서 난다. 따라서 타일 안 DEM 표본점에서의 최대 오차가
//   메시 표면 연속 영역 전체의 정확한 최대 오차다. (이전에는 양쪽을 쌍선형으로 재서 비틀린 칸에서 메시 오차를 놓쳤다.)
// - 오차 상한 보장: 명목 간격에서 상한 terrainLodMaxErrorM(lod, cellM) = min(TERRAIN_LOD_MAX_ERROR_M[lod],
//   TERRAIN_LOD_MAX_SLOPE_ERROR · cellM)(결정 0057, 셀 크기 비례 기울기 항) 을 넘는 타일이 하나라도 있으면
//   그 LOD 의 간격을 절반으로 줄여 다시 잰다(간격 1 = LOD 0 이면 오차 0 이므로 반드시 끝난다).
//   간격은 DEM 하나·LOD 하나에 대해 전역으로 정한다. 타일마다 다르게 고르면 같은 LOD 의 이웃이
//   가장자리 정점 수가 달라져 T 접합 균열이 생기므로, 균열 없음을 단순화 정도보다 우선했다.
// - 전제(F-313, 미해결): 봉합·스커트가 없다. 균열 없음은 '같은 DEM·같은 LOD 이웃'에서만 보장된다.
//   서로 다른 LOD(또는 다른 DEM) 타일이 이웃하면 공유 변에서 가는 쪽은 DEM 표본, 굵은 쪽은 선형 보간이라
//   최대 상한 수준(terrainLodMaxErrorM(lod, cellM) 의 큰 쪽)의 T 접합 틈이 날 수 있다. 가는 쪽 가장자리를 굵은 쪽
//   보간값으로 바꾸면 가는 쪽 LOD 의 오차 상한이 깨지므로, 섞어 쓰려면 스커트 또는 결정(F-309) 이 먼저 필요하다.
//   현재 호출자는 한 화면에서 이웃 타일 LOD 를 섞지 않는다고 가정한다.
// - 결정적: 부동소수 연산 순서가 입력만으로 정해지고, 정점 높이는 DEM Float32 값을 복사한다.
import {
  TERRAIN_TILE_SIZE_M,
  TERRAIN_LOD_COUNT,
  terrainLodMaxErrorM,
  TowerAssetError,
} from '../../../contracts/tower_assets/index.mjs';

const ALIGN_EPS = 1e-6;
// DEM 원점 절댓값 상한(m). 이보다 크면 타일 번호가 2^53 근처에서 tx++ 가 멈춰 무한 루프가 날 수 있다(F-315 ②).
// ENU(GeoAnchor 기준) 좌표라 1e7 m(지구 반지름 규모)를 넘는 값은 입력 오류로 본다.
export const TERRAIN_DEM_MAX_ABS_ORIGIN_M = 1e7;

/** 정수에 가까우면 그 정수, 아니면 null. */
function nearInt(v) {
  const r = Math.round(v);
  return Math.abs(v - r) <= ALIGN_EPS ? r : null;
}

function checkDem(dem) {
  if (!dem || typeof dem !== 'object') throw new TowerAssetError('dem 이 없다');
  const { originX, originY, cellM, width, height, heights } = dem;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) throw new TowerAssetError('dem origin 이 유한수가 아니다');
  if (Math.abs(originX) > TERRAIN_DEM_MAX_ABS_ORIGIN_M || Math.abs(originY) > TERRAIN_DEM_MAX_ABS_ORIGIN_M) {
    throw new TowerAssetError(`dem origin 절댓값이 ${TERRAIN_DEM_MAX_ABS_ORIGIN_M} m 를 넘는다`);
  }
  if (!(Number.isFinite(cellM) && cellM > 0)) throw new TowerAssetError('dem.cellM 은 양의 유한수');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) throw new TowerAssetError('dem 크기는 2 이상 정수');
  if (!(heights instanceof Float32Array) || heights.length !== width * height) throw new TowerAssetError('dem.heights 는 width·height 길이 Float32Array');
  const n0 = nearInt(TERRAIN_TILE_SIZE_M / cellM);
  if (n0 === null || n0 < 1) throw new TowerAssetError(`타일 한 변(${TERRAIN_TILE_SIZE_M} m)이 cellM 의 정수배가 아니다`);
  return n0;
}

function checkLod(lod) {
  if (!Number.isInteger(lod) || lod < 0 || lod >= TERRAIN_LOD_COUNT) throw new TowerAssetError(`lod 는 0..${TERRAIN_LOD_COUNT - 1} 정수`);
}

/** 타일 (tx, ty) 의 왼쪽 아래 정점이 놓이는 DEM 표본 번호. 정렬·범위·유한성을 검사한다. */
function tileOrigin(dem, n0, tx, ty) {
  if (!Number.isInteger(tx) || !Number.isInteger(ty)) throw new TowerAssetError('tx, ty 는 정수');
  const i0 = nearInt((tx * TERRAIN_TILE_SIZE_M - dem.originX) / dem.cellM);
  const j0 = nearInt((ty * TERRAIN_TILE_SIZE_M - dem.originY) / dem.cellM);
  if (i0 === null || j0 === null) throw new TowerAssetError('DEM 격자가 타일 경계에 맞지 않는다');
  if (i0 < 0 || j0 < 0 || i0 + n0 > dem.width - 1 || j0 + n0 > dem.height - 1) {
    throw new TowerAssetError(`타일 (${tx}, ${ty}) 이 DEM 범위를 벗어난다`);
  }
  for (let j = j0; j <= j0 + n0; j++) {
    for (let i = i0; i <= i0 + n0; i++) {
      if (!Number.isFinite(dem.heights[j * dem.width + i])) throw new TowerAssetError(`타일 (${tx}, ${ty}) 에 유한하지 않은 높이`);
    }
  }
  return { i0, j0 };
}

/** n0 를 나누는 2 의 거듭제곱 가운데 2^lod 이하 최댓값(명목 간격). */
function nominalStride(n0, lod) {
  let s = 1;
  while (s < (1 << lod) && n0 % (s * 2) === 0) s *= 2;
  return s;
}

/**
 * 격자 값 z(i, j) (타일 국소 정점 번호) 로 만든 삼각형 메시 표면(terrainTileToMesh 와 같은 대각선 규약)과
 * DEM 표본의 최대 차이를 DEM 표본점에서 잰다. stride = 타일 정점 간격(DEM 셀 단위).
 * 머리 주석대로 이 값이 메시 표면 연속 영역의 정확한 최대다.
 */
function gridError(dem, i0, j0, n0, stride, z) {
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
      // 대각선 (ci,cj)–(ci+1,cj+1): fx ≥ fy 면 삼각형 a·b·e, 아니면 a·e·d (terrainTileToMesh 와 같다).
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

/** 간격 stride 로 부분 표본했을 때의 타일 최대 오차. */
function strideError(dem, i0, j0, n0, stride) {
  if (stride === 1) return 0;
  const w = dem.width;
  const h = dem.heights;
  return gridError(dem, i0, j0, n0, stride, (ci, cj) => h[(j0 + cj * stride) * w + i0 + ci * stride]);
}

/** DEM 이 완전히 덮는 모든 타일의 [왼쪽 아래 DEM 표본 번호 i0, j0, tx, ty]. origin 상한(checkDem) 덕에 tx·ty 는 안전 정수 범위다. */
function coveredTileOrigins(dem, n0) {
  const out = [];
  const t = TERRAIN_TILE_SIZE_M;
  // + 0: Math.ceil(−ε) 가 −0 을 내므로 타일 번호를 +0 으로 맞춘다.
  const txMin = Math.ceil(dem.originX / t - ALIGN_EPS) + 0;
  const tyMin = Math.ceil(dem.originY / t - ALIGN_EPS) + 0;
  for (let ty = tyMin; ; ty++) {
    const j0 = nearInt((ty * t - dem.originY) / dem.cellM);
    if (j0 === null || j0 + n0 > dem.height - 1) break;
    for (let tx = txMin; ; tx++) {
      const i0 = nearInt((tx * t - dem.originX) / dem.cellM);
      if (i0 === null || i0 + n0 > dem.width - 1) break;
      out.push([i0, j0, tx, ty]);
    }
  }
  return out;
}

// 전역 간격 캐시: heights 배열 → (DEM 매개변수 서명, LOD 별 간격). heights 를 제자리 수정했다면 새 배열을 넘길 것.
const strideCache = new WeakMap();

function tileHasNonFinite(dem, i0, j0, n0) {
  for (let j = j0; j <= j0 + n0; j++) {
    for (let i = i0; i <= i0 + n0; i++) if (!Number.isFinite(dem.heights[j * dem.width + i])) return true;
  }
  return false;
}

/**
 * DEM 이 덮는 타일 가운데 유한하지 않은 높이(NaN·±Infinity)가 섞인 결측 타일 목록 [{ tx, ty }] (ty, tx 오름차순).
 * 이 타일들은 간격 판정에서 빠지고 buildTerrainTile·measureTerrainError 는 TowerAssetError 를 던진다(F-314 ⑥).
 */
export function terrainMissingTiles(dem) {
  const n0 = checkDem(dem);
  const out = [];
  for (const [i0, j0, tx, ty] of coveredTileOrigins(dem, n0)) if (tileHasNonFinite(dem, i0, j0, n0)) out.push({ tx, ty });
  return out;
}

/** DEM 하나·LOD 하나의 실제 간격(DEM 셀 단위). DEM 이 덮는 모든 타일이 오차 상한을 만족하는 가장 큰 간격. */
export function terrainLodStride(dem, lod) {
  const n0 = checkDem(dem);
  checkLod(lod);
  const sig = `${dem.originX},${dem.originY},${dem.cellM},${dem.width},${dem.height}`;
  let entry = strideCache.get(dem.heights);
  if (!entry || entry.sig !== sig) {
    entry = { sig, strides: new Array(TERRAIN_LOD_COUNT).fill(0) };
    strideCache.set(dem.heights, entry);
  }
  if (entry.strides[lod]) return entry.strides[lod];
  const limit = terrainLodMaxErrorM(lod, dem.cellM); // 결정 0057: min(절대 상한, 기울기 상한 · cellM)
  // 결측 타일(terrainMissingTiles)은 명시적으로 빼고 판정한다.
  const tiles = coveredTileOrigins(dem, n0).filter(([i0, j0]) => !tileHasNonFinite(dem, i0, j0, n0));
  let stride = nominalStride(n0, lod);
  while (stride > 1) {
    let ok = true;
    for (const [i0, j0] of tiles) {
      if (strideError(dem, i0, j0, n0, stride) > limit) { ok = false; break; }
    }
    if (ok) break;
    stride /= 2;
  }
  entry.strides[lod] = stride;
  return stride;
}

/**
 * (dem, tx, ty, lod) → TerrainTile. cells = 한 변 정점 수, heights[j·cells + i],
 * 정점 (i, j) 위치 = (64·tx + i·64/(cells−1), 64·ty + j·64/(cells−1)).
 */
export function buildTerrainTile(dem, tx, ty, lod) {
  const n0 = checkDem(dem);
  checkLod(lod);
  const { i0, j0 } = tileOrigin(dem, n0, tx, ty);
  const stride = terrainLodStride(dem, lod);
  const cells = n0 / stride + 1;
  const out = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) {
    const row = (j0 + j * stride) * dem.width + i0;
    for (let i = 0; i < cells; i++) out[j * cells + i] = dem.heights[row + i * stride];
  }
  return { tx, ty, lod, cells, heights: out };
}

function checkTile(tile) {
  if (!tile || !Number.isInteger(tile.cells) || tile.cells < 2) throw new TowerAssetError('tile.cells 는 2 이상 정수');
  if (!(tile.heights instanceof Float32Array) || tile.heights.length !== tile.cells * tile.cells) throw new TowerAssetError('tile.heights 길이가 cells² 이 아니다');
  if (!Number.isInteger(tile.tx) || !Number.isInteger(tile.ty)) throw new TowerAssetError('tile.tx, ty 는 정수');
  for (let k = 0; k < tile.heights.length; k++) {
    if (!Number.isFinite(tile.heights[k])) throw new TowerAssetError(`tile.heights[${k}] 가 유한수가 아니다`);
  }
}

/**
 * (dem, tile) → { maxErrorM }. 타일 메시 표면(삼각형 보간)과 원본 DEM 메시(같은 대각선 규약의 삼각형 보간)의
 * 차이 |Δz| 의 타일 영역 최댓값. 상한 terrainLodMaxErrorM(lod, cellM)(계약 TERRAIN_LOD_MAX_ERROR_M 과 기울기 항의 min) 은 이 '메시 표면 기준' 값에 대한 상한이다.
 * 타일 정점이 DEM 표본 위에 있어야 한다(buildTerrainTile 출력은 항상 그렇다).
 */
export function measureTerrainError(dem, tile) {
  const n0 = checkDem(dem);
  checkTile(tile);
  const { i0, j0 } = tileOrigin(dem, n0, tile.tx, tile.ty);
  const n = tile.cells - 1;
  if (n0 % n !== 0) throw new TowerAssetError('타일 정점이 DEM 표본 위에 놓이지 않는다');
  const c = tile.cells;
  const th = tile.heights;
  return { maxErrorM: gridError(dem, i0, j0, n0, n0 / n, (ci, cj) => th[cj * c + ci]) };
}

/**
 * (tile) → Mesh. 정점 (i, j) → positions[3·(j·cells+i) ..+3] = (x, y, z) ENU m.
 * 칸마다 삼각형 2개, 대각선은 항상 (i,j)–(i+1,j+1), 위(+Z)에서 볼 때 반시계.
 */
export function terrainTileToMesh(tile) {
  checkTile(tile);
  const c = tile.cells;
  const step = TERRAIN_TILE_SIZE_M / (c - 1);
  const x0 = tile.tx * TERRAIN_TILE_SIZE_M;
  const y0 = tile.ty * TERRAIN_TILE_SIZE_M;
  const positions = new Float32Array(c * c * 3);
  for (let j = 0; j < c; j++) {
    for (let i = 0; i < c; i++) {
      const k = (j * c + i) * 3;
      // 마지막 행·열은 다음 타일 원점과 정확히 같은 식으로 둔다(경계 좌표 비트 일치).
      positions[k] = i === c - 1 ? (tile.tx + 1) * TERRAIN_TILE_SIZE_M : x0 + i * step;
      positions[k + 1] = j === c - 1 ? (tile.ty + 1) * TERRAIN_TILE_SIZE_M : y0 + j * step;
      positions[k + 2] = tile.heights[j * c + i];
    }
  }
  const indices = new Uint32Array((c - 1) * (c - 1) * 6);
  let p = 0;
  for (let j = 0; j < c - 1; j++) {
    for (let i = 0; i < c - 1; i++) {
      const a = j * c + i, b = a + 1, d = a + c, e = d + 1;
      indices[p++] = a; indices[p++] = b; indices[p++] = e;
      indices[p++] = a; indices[p++] = e; indices[p++] = d;
    }
  }
  return { positions, indices };
}
