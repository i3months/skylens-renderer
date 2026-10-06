// T15.10b-B1(F-458 비교안 (i)(ii)) 전용: 높이 오차 상한표를 인자로 받는 지형 LOD 간격·타일 생성 사본.
// server/terrain/mesh_lod/index.mjs 의 terrainLodStride·buildTerrainTile 과 같은 규칙을 그대로 옮겼고, 상한표만 인자다.
// 서버 코드·계약(contracts/tower_assets TERRAIN_LOD_MAX_ERROR_M)은 고치지 않는다. 검증·결측 처리는 측정용 합성 DEM 이
// 늘 유한·정렬돼 있다는 전제로 줄였고, 대신 b1_measure.mjs 가 현행표 [0,0.5,1,1] 에서 이 사본의 간격·높이가 서버 함수와
// 같은지 DEM 마다 대조한다(다르면 던진다).
//
// 규칙(서버와 같음):
// - LOD k 명목 간격 = 2^k(64 m / cellM 을 나누는 범위에서). 그 간격에서 타일 하나라도 메시 표면 오차가 상한을 넘으면
//   간격을 절반으로 줄여 다시 잰다(간격 1 = 원본이면 오차 0). 간격은 DEM 하나·LOD 하나에 전역 하나.
// - 오차 = 대각선 (i,j)–(i+1,j+1) 규약 삼각형 보간 표면과 DEM 표본의 차 최댓값(DEM 표본점에서 잰 값이 정확한 최대).
import { TERRAIN_TILE_SIZE_M, TERRAIN_LOD_COUNT } from '../../../contracts/tower_assets/index.mjs';

/** 비교안 상한표(m). (i) 현행(결정 0046 T15.1c), (ii) 옛 값(결정 0044 §5). 측정 전에 정한 값이며 측정에 맞춰 바꾸지 않는다. */
export const B1_OPTIONS = Object.freeze({
  i: Object.freeze([0, 0.5, 1, 1]),
  ii: Object.freeze([0, 0.5, 1, 2]),
});

function n0Of(dem) {
  const n0 = Math.round(TERRAIN_TILE_SIZE_M / dem.cellM);
  if (Math.abs(n0 * dem.cellM - TERRAIN_TILE_SIZE_M) > 1e-9) throw new Error('타일 한 변이 cellM 의 정수배가 아니다');
  return n0;
}

function nominalStride(n0, lod) {
  let s = 1;
  while (s < (1 << lod) && n0 % (s * 2) === 0) s *= 2;
  return s;
}

/** 서버 gridError 와 같은 식: 간격 stride 로 부분 표본한 타일 표면의 최대 오차. */
function strideError(dem, i0, j0, n0, stride) {
  if (stride === 1) return 0;
  const n = n0 / stride;
  const w = dem.width;
  const h = dem.heights;
  const z = (ci, cj) => h[(j0 + cj * stride) * w + i0 + ci * stride];
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

/** DEM 이 완전히 덮는 타일의 [i0, j0] 목록(서버 coveredTileOrigins 와 같은 범위, 정렬된 DEM 전제). */
function coveredTileOrigins(dem, n0) {
  const out = [];
  const t = TERRAIN_TILE_SIZE_M;
  const txMin = Math.ceil(dem.originX / t - 1e-6);
  const tyMin = Math.ceil(dem.originY / t - 1e-6);
  for (let ty = tyMin; ; ty++) {
    const j0 = Math.round((ty * t - dem.originY) / dem.cellM);
    if (j0 + n0 > dem.height - 1) break;
    for (let tx = txMin; ; tx++) {
      const i0 = Math.round((tx * t - dem.originX) / dem.cellM);
      if (i0 + n0 > dem.width - 1) break;
      out.push([i0, j0]);
    }
  }
  return out;
}

/**
 * 상한표 bounds 아래에서 DEM 의 LOD 별 전역 간격과 그 간격의 타일 최대 오차.
 * @returns {{ strides:number[], maxErrorM:number[] }}
 */
export function lodStrides(dem, bounds) {
  if (!Array.isArray(bounds) && !(bounds && typeof bounds.length === 'number')) throw new Error('bounds 는 배열');
  if (bounds.length !== TERRAIN_LOD_COUNT) throw new Error(`bounds 길이 ${bounds.length} != ${TERRAIN_LOD_COUNT}`);
  const n0 = n0Of(dem);
  const tiles = coveredTileOrigins(dem, n0);
  const strides = [], maxErrorM = [];
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    const limit = bounds[lod];
    let stride = nominalStride(n0, lod);
    let worst = 0;
    while (stride > 1) {
      let ok = true;
      worst = 0;
      for (const [i0, j0] of tiles) {
        const e = strideError(dem, i0, j0, n0, stride);
        if (e > worst) worst = e;
        if (e > limit) { ok = false; break; }
      }
      if (ok) break;
      stride /= 2;
    }
    if (stride === 1) worst = 0;
    strides.push(stride);
    maxErrorM.push(worst);
  }
  return { strides, maxErrorM };
}

/** 간격 stride 로 만든 타일(서버 buildTerrainTile 과 같은 모양: { tx, ty, lod, cells, heights }). */
export function buildTileWithStride(dem, tx, ty, lod, stride) {
  const n0 = n0Of(dem);
  const i0 = Math.round((tx * TERRAIN_TILE_SIZE_M - dem.originX) / dem.cellM);
  const j0 = Math.round((ty * TERRAIN_TILE_SIZE_M - dem.originY) / dem.cellM);
  if (i0 < 0 || j0 < 0 || i0 + n0 > dem.width - 1 || j0 + n0 > dem.height - 1) throw new Error(`타일 (${tx}, ${ty}) 이 DEM 밖`);
  const cells = n0 / stride + 1;
  const out = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) {
    const row = (j0 + j * stride) * dem.width + i0;
    for (let i = 0; i < cells; i++) out[j * cells + i] = dem.heights[row + i * stride];
  }
  return { tx, ty, lod, cells, heights: out };
}
