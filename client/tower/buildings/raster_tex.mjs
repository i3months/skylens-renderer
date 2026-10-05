// T15.3 건물 면 z-버퍼 래스터(항공영상 지붕). 계약: contracts/controlview/buildings.mjs BUILDINGS_MODULES.raster_tex.
// 삼각형·깊이 규약은 raster_flat.mjs 의 공용 핵심(rasterizeGroupsCore)과 같다.
// uv 규약: (0,0) = 영상 왼쪽 아래(남서), (1,1) = 오른쪽 위(북동), v 는 북쪽으로 증가. 영상 행 0 = 북.
//   그래서 화소 중심 기준 표본 좌표는 col = u·width − 0.5, row = (1 − v)·height − 0.5 이다.
// 이중선형 표본: 네 이웃 화소를 가장자리에서 끝 화소로 클램프하고 무게 평균한 뒤 반올림(Math.round)한다.
// wallMask=1 정점이 하나라도 있는 삼각형, 또는 image 가 null 이면 BUILDINGS_DEFAULTS.faceRgb(검정 면 색)로 그린다
//   (영상 색을 섞지 않고, 영상이 없는 것을 메우지 않는다).
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';
import { rasterizeGroupsCore } from './raster_flat.mjs';

const ERR = 'buildings/raster_tex:';

/**
 * 항공영상 rgb 를 (u,v) 에서 이중선형으로 표본한다(가장자리 클램프). 결과는 dst[off..off+2] 에 쓴다.
 * @param {{width:number, height:number, rgb:Uint8Array}} image
 * @param {number} u
 * @param {number} v
 * @param {Uint8Array} dst
 * @param {number} off
 */
export function sampleBilinear(image, u, v, dst, off) {
  const W = image.width; const H = image.height; const rgb = image.rgb;
  const col = u * W - 0.5;
  const row = (1 - v) * H - 0.5;
  const c0 = Math.floor(col); const r0 = Math.floor(row);
  const ax = col - c0; const ay = row - r0;
  const cA = c0 < 0 ? 0 : (c0 > W - 1 ? W - 1 : c0);
  const cB = c0 + 1 < 0 ? 0 : (c0 + 1 > W - 1 ? W - 1 : c0 + 1);
  const rA = r0 < 0 ? 0 : (r0 > H - 1 ? H - 1 : r0);
  const rB = r0 + 1 < 0 ? 0 : (r0 + 1 > H - 1 ? H - 1 : r0 + 1);
  const p00 = 3 * (rA * W + cA); const p01 = 3 * (rA * W + cB);
  const p10 = 3 * (rB * W + cA); const p11 = 3 * (rB * W + cB);
  const w00 = (1 - ax) * (1 - ay); const w01 = ax * (1 - ay);
  const w10 = (1 - ax) * ay; const w11 = ax * ay;
  for (let k = 0; k < 3; k += 1) {
    const s = w00 * rgb[p00 + k] + w01 * rgb[p01 + k] + w10 * rgb[p10 + k] + w11 * rgb[p11 + k];
    const q = Math.round(s);
    dst[off + k] = q < 0 ? 0 : (q > 255 ? 255 : q);
  }
}

function assertImage(image) {
  if (image === null) return;
  if (!image || typeof image !== 'object') throw new TypeError(`${ERR} image 는 AerialImage 또는 null`);
  const { width, height, rgb } = image;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError(`${ERR} image 크기는 양의 정수여야 함: ${String(width)}×${String(height)}`);
  }
  if (!(rgb instanceof Uint8Array) || rgb.length !== 3 * width * height) throw new TypeError(`${ERR} image.rgb 길이는 3·width·height`);
}

/**
 * 건물 묶음들을 그린다. 지붕(wallMask 0 삼각형)은 uv 원근 보정 보간 + 이중선형 표본, 나머지는 faceRgb.
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {import('../../../contracts/controlview/buildings.mjs').BuildingGroup[]} groups
 * @param {import('../../../contracts/controlview/buildings.mjs').AerialImage|null} image
 * @param {import('../../../contracts/raster/index.mjs').RenderResult} out emptyResult(비어 있지 않아도 됨, 제자리 갱신)
 * @returns {void}
 */
export function rasterizeTextured(camera, groups, image, out) {
  assertImage(image);
  const face = BUILDINGS_DEFAULTS.faceRgb;
  const color = out && out.color;
  const hasImage = image !== null;
  if (hasImage && Array.isArray(groups)) {
    for (let g = 0; g < groups.length; g += 1) {
      const grp = groups[g];
      const nv = grp && grp.mesh && grp.mesh.positions ? Math.floor(grp.mesh.positions.length / 3) : 0;
      if (!grp || !(grp.wallMask instanceof Uint8Array) || grp.wallMask.length !== nv) {
        throw new TypeError(`${ERR} 묶음 ${g}: wallMask(Uint8Array) 길이는 정점 수`);
      }
    }
  }
  let wall = true;
  let mask = null;
  rasterizeGroupsCore(camera, groups, (g, tri, i0, i1, i2) => {
    if (!hasImage) { wall = true; return; }
    mask = groups[g].wallMask;
    wall = mask[i0] === 1 || mask[i1] === 1 || mask[i2] === 1;
  }, (c3, u, v) => {
    if (wall) {
      color[c3] = face[0]; color[c3 + 1] = face[1]; color[c3 + 2] = face[2];
    } else {
      sampleBilinear(image, u, v, color, c3);
    }
  }, out, (g) => (hasImage ? groups[g].uv : null));
}
