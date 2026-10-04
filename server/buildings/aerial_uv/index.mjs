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
//   3) 벽(수직 면): 정사 영상에는 벽면이 거의 보이지 않으므로, 벽 정점은 같은 투영으로 바닥 외곽 위치 (x, y) 를 샘플한다.
//      벽의 위·아래 정점(z 만 다른 두 정점)은 같은 UV 를 가져 외곽선 픽셀이 수직으로 늘어난다.
//   4) 따라서 지붕·벽 규칙은 모두 "정점 (x, y) 의 평면 투영"으로 귀결되고 UV 는 정점 위치만의 함수다.
//      면 방향과 무관하므로 지붕과 벽이 정점을 공유하는 메시에서도 값이 하나로 정해지고,
//      삼각형 순서·인덱스에 의존하지 않아 결정적이다.
// 영상 밖 정점(x ∉ [minX, maxX] 또는 y ∉ [minY, maxY])은 [0,1] 로 잘라 채우지 않고 TowerAssetError 로 던진다.
// 잘라 채우면 가장자리 픽셀이 조용히 번져 정합 오류를 숨기기 때문이다. 경계 위의 점(= minX 등)은 허용한다.
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
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TowerAssetError(`aerial_uv: 정점 좌표가 유한하지 않다 (${x}, ${y})`);
  }
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) {
    throw new TowerAssetError(`aerial_uv: 정점 (${x}, ${y}) 이 영상 범위 밖이다`);
  }
  const u = (x - b.minX) / (b.maxX - b.minX);
  const v = 1 - (y - b.minY) / (b.maxY - b.minY);
  return [u, v];
}

/**
 * 건물 메시 정점마다 항공 영상 UV 를 만든다.
 * @param {{positions:Float32Array, indices:Uint32Array}} mesh
 * @param {{width:number,height:number,rgb:Uint8Array,bounds:{minX:number,minY:number,maxX:number,maxY:number}}} image
 * @returns {{ uv: Float32Array }} 정점당 (u, v), 값 ∈ [0,1]
 */
export function buildAerialUv(mesh, image) {
  const b = checkImage(image);
  checkMesh(mesh);
  const p = mesh.positions;
  const n = p.length / 3;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const [u, v] = aerialUvOf(p[i * 3], p[i * 3 + 1], b);
    // [0,1] 안의 double 은 Float32 로 반올림해도 [0,1] 안에 남는다(0 과 1 이 정확히 표현되므로).
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  return { uv };
}
