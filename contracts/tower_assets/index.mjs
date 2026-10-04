// 관제탑 자산(T14) 계약. 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m, X 동·Y 북·Z 위.
// 하위 작업 T14.1~T14.10 이 구현할 함수의 서명은 ./stubs.mjs 에 있다. 모든 출력은 결정적이어야 한다(같은 입력 → 같은 바이트).

/** 지형 타일 한 변(m). 자산 포맷의 TILE_SIZE_M 과 같다. */
export const TERRAIN_TILE_SIZE_M = 64;
/** 지형 LOD 단계 수. 0 = 원본 DEM 격자, 단계가 오를 때마다 한 변 셀 수가 절반. */
export const TERRAIN_LOD_COUNT = 4;
/** 지형 LOD 단계별 높이 오차 상한(m): 내보내는 삼각형 메시 표면과 원본 DEM 표본의 높이 차 최댓값이 이 값 이하다(메시 표면 기준, 결정 0044 §5). */
export const TERRAIN_LOD_MAX_ERROR_M = Object.freeze([0, 0.5, 1, 2]);
/** 드레이프 밉 단계 수. 0 = 가장 세밀. */
export const DRAPE_MIP_COUNT = 4;
/** 건물 높이 규칙: 층 수가 있으면 층 × 3 m, 없으면 6 m. */
export const BUILDING_FLOOR_HEIGHT_M = 3;
export const BUILDING_DEFAULT_HEIGHT_M = 6;
/** 좌표 정합 허용(픽셀). */
export const ALIGN_TOLERANCE_PX = 1;
/** 건물 LOD 병합 시점 SSIM 하한(8시점). */
export const BUILDING_LOD_MIN_SSIM = 0.95;

/** 표시 옵션 3종. 기본은 검정 텍스처 건물. */
export const DISPLAY_MODES = Object.freeze(['points', 'black', 'aerial']);
export const DEFAULT_DISPLAY_MODE = 'black';

/**
 * 건물 높이(m). floors 가 양의 유한수면 floors × 3, 아니면 6.
 * @param {number|null|undefined} floors
 */
export function buildingHeightM(floors) {
  return Number.isFinite(floors) && floors > 0 ? floors * BUILDING_FLOOR_HEIGHT_M : BUILDING_DEFAULT_HEIGHT_M;
}

/**
 * 입력 타입(JSDoc).
 * @typedef {{ originX:number, originY:number, cellM:number, width:number, height:number, heights:Float32Array }} Dem
 *   DEM 격자. (originX, originY) = 왼쪽 아래 셀 중심 ENU, 셀 (i, j) 중심 = origin + (i·cellM, j·cellM), heights[j·width + i] (m).
 * @typedef {{ tx:number, ty:number, lod:number, cells:number, heights:Float32Array }} TerrainTile
 *   tx = floor(x/64), ty = floor(y/64). cells = 한 변 정점 수(경계 공유, 인접 타일과 같은 가장자리 높이). heights[j·cells + i].
 * @typedef {{ positions:Float32Array, indices:Uint32Array }} Mesh  positions = xyz 연속, indices = 삼각형(반시계, 위에서 볼 때).
 * @typedef {{ id:number, ring:Array<[number,number]>, floors?:number|null }} Footprint
 *   id 는 안정 식별자(u32). ring = 외곽 ENU xy, 닫지 않은 단순 다각형(첫 점 반복 없음), 방향은 임의.
 * @typedef {{ complete:boolean, fraction:number, mask:Uint8Array, bounds:Bounds }} DrapeCoverage
 *   영상이 덮은 부분. mask 는 화소별 0(자료 없음)~255(완전히 덮임). mask 0 인 화소의 rgb 는 영상이 아니다(채우지 않는다, 결정 0044 §2).
 * @typedef {{ tx:number, ty:number, mip:number, width:number, height:number, rgb:Uint8Array, coverage:DrapeCoverage }} DrapeTile
 *   rgb = width·height·3, 행 우선 위에서 아래(북 → 남, 행 0 = 북). 타일 범위는 지형 타일과 같다.
 * @typedef {{ minX:number, minY:number, maxX:number, maxY:number }} Bounds
 */

export class TowerAssetError extends Error {
  constructor(message) { super(message); this.name = 'TowerAssetError'; }
}

/** 타일 번호 → 범위(ENU m). */
export function tileBounds(tx, ty) {
  return { minX: tx * TERRAIN_TILE_SIZE_M, minY: ty * TERRAIN_TILE_SIZE_M, maxX: (tx + 1) * TERRAIN_TILE_SIZE_M, maxY: (ty + 1) * TERRAIN_TILE_SIZE_M };
}

/** 좌표 → 타일 번호. */
export function tileOf(x, y) {
  return { tx: Math.floor(x / TERRAIN_TILE_SIZE_M), ty: Math.floor(y / TERRAIN_TILE_SIZE_M) };
}

/** 다각형 부호 있는 넓이(반시계 > 0). */
export function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}
