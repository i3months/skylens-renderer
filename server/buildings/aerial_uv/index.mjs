// T14.7 실사 항공뷰 옵션: 건물 메시 정점마다 위성(정사) 영상 UV 를 만든다.
// 계약: contracts/tower_assets (서명은 stubs.mjs 의 buildAerialUv). ENU 1 unit = 1 m, X 동·Y 북·Z 위.
//
// UV 규칙(정점당 2 float, u·v ∈ [0,1]):
//   u = (x − minX) / (maxX − minX)
//   v = 1 − (y − minY) / (maxY − minY)
//   z 는 쓰지 않는다.
// 근거:
//   1) 영상은 정사 영상이라 지상 (x, y) 한 점이 영상 한 점에 대응한다. 영상 bounds(ENU) 를 [0,1] 로 펴면
//      u 는 서 → 동, v 는 행 순서(rgb 행 우선 위에서 아래 = 북 → 남, 계약 DrapeTile 과 같은 관례)를 따르므로
//      북쪽 끝 y = maxY 가 v = 0, 남쪽 끝 y = minY 가 v = 1 이다.
//   2) 지붕(위를 향한 면): 위에서 내려다본 영상의 지붕 픽셀이 곧 그 정점의 (x, y) 에 있으므로 평면 투영 그대로다.
//      높이 z 로 인한 기복 변위(relief displacement)는 정사 보정된 영상으로 보고 보정하지 않는다.
//   3) 벽(수직 면)·바닥 덮개: 정사 영상에 없는 면이므로 영상 색으로 메우지 않는다(RULES 1.2, F-312).
//      위를 향한 삼각형(법선 z 비율 > ROOF_NORMAL_Z_MIN)에 한 번도 쓰이지 않는 정점은 wallMask[i] = 1 이다.
//      wallMask 가 1 인 정점의 uv 값은 의미가 없고(평면 투영 값이 그대로 들어 있을 뿐), 소비자는 영상을 샘플하지 말고
//      검정 기본 표시로 그려야 한다. uv 배열 모양(정점당 2 float)은 계약 서명 그대로 두고 wallMask 만 더한다.
//   4) 지붕 정점의 UV 는 정점 (x, y) 의 평면 투영이며 정점 위치만의 함수다. 지붕과 벽이 정점을 공유하면 지붕으로 친다(mask 0).
//      삼각형 순서·인덱스에 의존하지 않아 결정적이다.
// 행 관례: 영상 rgb 는 행 0 = 북쪽 끝(y = maxY), 행이 늘면 남쪽이다(렌더러 샘플링 관례, 계약 DrapeTile 과 같다). v = 0 이 행 0 의 위 가장자리.
// 영상 밖 정점(x ∉ [minX, maxX] 또는 y ∉ [minY, maxY])은 [0,1] 로 잘라 채우지 않고 TowerAssetError 로 던진다.
// 잘라 채우면 가장자리 픽셀이 조용히 번져 정합 오류를 숨기기 때문이다. 경계 위의 점(= minX 등)은 허용한다.
// 단 메시 정점은 Float32 라 double 경계 maxX 가 Float32 로 표현되지 않으면 fround(maxX) > maxX 일 수 있다.
// buildAerialUv 는 경계를 Float32 로 반올림한 값까지 같은 경계로 보고 u·v 는 [0,1] 로 한정한다(오차 2^-24 상대).
//
// UV ↔ 픽셀(연속 좌표): px = u · width, py = v · height. 픽셀 (col, row) 는 px ∈ [col, col+1), py ∈ [row, row+1) 를 덮는다.
// Float32 저장 오차는 상대 2^-24 수준이라 width 가 수만 px 이어도 0.01 px 보다 작다.

import { TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

function checkImage(image) {
  if (!image || typeof image !== 'object') throw new TowerAssetError('aerial_uv: image 가 없다');
  const { width, height, rgb, bounds } = image;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TowerAssetError(`aerial_uv: 영상 크기가 잘못됐다 (${width}×${height})`);
  }
  if (!(rgb instanceof Uint8Array) || rgb.length !== width * height * 3) {
    throw new TowerAssetError('aerial_uv: rgb 는 width·height·3 길이의 Uint8Array 여야 한다');
  }
  if (!bounds) throw new TowerAssetError('aerial_uv: bounds 가 없다');
  const { minX, minY, maxX, maxY } = bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || !(maxX > minX) || !(maxY > minY)) {
    throw new TowerAssetError('aerial_uv: bounds 가 유한하지 않거나 넓이가 0 이다');
  }
  return { minX, minY, maxX, maxY };
}

/** 위를 향한 삼각형(지붕) 판정 문턱: 법선 z 성분 비율. points 의 ROOF_NORMAL_Z_MIN 과 같은 값. */
export const ROOF_NORMAL_Z_MIN = 0.5;

function checkBounds(b) {
  if (!b || ![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) || !(b.maxX > b.minX) || !(b.maxY > b.minY)) {
    throw new TowerAssetError('aerial_uv: bounds 가 유한하지 않거나 넓이가 0 이다');
  }
}

function checkMesh(mesh) {
  if (!mesh || !(mesh.positions instanceof Float32Array) || mesh.positions.length % 3 !== 0) {
    throw new TowerAssetError('aerial_uv: mesh.positions 는 길이가 3 의 배수인 Float32Array 여야 한다');
  }
}

/**
 * 한 점 (x, y) 의 항공 UV. 영상 밖이거나 유한하지 않으면 TowerAssetError.
 * @param {number} x
 * @param {number} y
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} b
 * @returns {[number, number]}
 */
export function aerialUvOf(x, y, b) {
  checkBounds(b);
  return uvAt(x, y, b, false);
}

// f32 가 true 면 경계를 Float32 반올림 값까지 넓혀 허용하고 결과를 [0,1] 로 한정한다.
function uvAt(x, y, b, f32) {
  const lx = f32 ? Math.min(b.minX, Math.fround(b.minX)) : b.minX, hx = f32 ? Math.max(b.maxX, Math.fround(b.maxX)) : b.maxX;
  const ly = f32 ? Math.min(b.minY, Math.fround(b.minY)) : b.minY, hy = f32 ? Math.max(b.maxY, Math.fround(b.maxY)) : b.maxY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TowerAssetError(`aerial_uv: 정점 좌표가 유한하지 않다 (${x}, ${y})`);
  }
  if (x < lx || x > hx || y < ly || y > hy) {
    throw new TowerAssetError(`aerial_uv: 정점 (${x}, ${y}) 이 영상 범위 밖이다`);
  }
  let u = (x - b.minX) / (b.maxX - b.minX);
  let v = 1 - (y - b.minY) / (b.maxY - b.minY);
  if (f32) { u = Math.min(1, Math.max(0, u)); v = Math.min(1, Math.max(0, v)); }
  return [u, v];
}

/**
 * 건물 메시 정점마다 항공 영상 UV 를 만든다.
 * @param {{positions:Float32Array, indices:Uint32Array}} mesh
 * @param {{width:number,height:number,rgb:Uint8Array,bounds:{minX:number,minY:number,maxX:number,maxY:number}}} image
 * @returns {{ uv: Float32Array, wallMask: Uint8Array }} uv: 정점당 (u, v) ∈ [0,1]. wallMask: 정점당 1 = 영상 없는 면(벽·바닥)만 쓰는 정점, 검정으로 그린다
 */
export function buildAerialUv(mesh, image) {
  const b = checkImage(image);
  checkMesh(mesh);
  const p = mesh.positions;
  const n = p.length / 3;
  const uv = new Float32Array(n * 2);
  const wallMask = new Uint8Array(n).fill(1);
  const idx = mesh.indices;
  if (idx) {
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t], bb = idx[t + 1], c = idx[t + 2];
      if (!(a < n && bb < n && c < n)) throw new TowerAssetError('aerial_uv: 인덱스가 정점 범위 밖이다');
      const ux = p[bb * 3] - p[a * 3], uy = p[bb * 3 + 1] - p[a * 3 + 1];
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1];
      const nz = ux * vy - uy * vx;
      const nx = (p[bb * 3 + 1] - p[a * 3 + 1]) * (p[c * 3 + 2] - p[a * 3 + 2]) - (p[bb * 3 + 2] - p[a * 3 + 2]) * vy;
      const ny = (p[bb * 3 + 2] - p[a * 3 + 2]) * vx - ux * (p[c * 3 + 2] - p[a * 3 + 2]);
      const len = Math.hypot(nx, ny, nz);
      if (len > 0 && nz / len > ROOF_NORMAL_Z_MIN) { wallMask[a] = 0; wallMask[bb] = 0; wallMask[c] = 0; }
    }
  }
  for (let i = 0; i < n; i++) {
    const [u, v] = uvAt(p[i * 3], p[i * 3 + 1], b, true);
    // [0,1] 안의 double 은 Float32 로 반올림해도 [0,1] 안에 남는다(0 과 1 이 정확히 표현되므로).
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  return { uv, wallMask };
}
