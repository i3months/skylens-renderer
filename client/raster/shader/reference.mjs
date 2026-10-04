// T12.2 점 셰이더의 CPU 참조 래스터라이저. 새 식을 만들지 않고 참조 구현을 그대로 잇는다:
//   깊이 버퍼 원판 = server/raster_ref/zbuffer renderPoints(지름 pointSizeM, 같은 깊이면 먼저 온 점)
//   셰이딩       = server/raster_ref/shade shadeResult(contracts/raster shade 의 lambert 식)
//   법선 복호     = server/asset/unpack decodeOctNormal(ASSET_FORMAT §5.3·§6)
// 입력은 셰이더가 받는 것과 같은 GPU 평면(위치 f32·색 u8·법선 팔면체 i8 쌍)이다.
import { renderPoints } from '../../../server/raster_ref/zbuffer/index.mjs';
import { shadeResult } from '../../../server/raster_ref/shade/index.mjs';
import { decodeOctNormal } from '../../../server/asset/unpack/index.mjs';

/**
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera 장치 픽셀 카메라(width×height = 그리기 버퍼)
 * @param {{positions: Float32Array, colors: Uint8Array, normalOct?: Int8Array}} pts
 * @param {{pointSizeM: number, lightDirWorld?: number[], ambient?: number, shade?: boolean}} opts
 * @returns {import('../../../contracts/raster/index.mjs').RenderResult}
 */
export function referencePointRender(camera, pts, opts) {
  const res = renderPoints(camera, { format: 1, positions: pts.positions, colors: pts.colors }, { pointSizeM: opts.pointSizeM });
  if (opts.shade === false) return res;
  const n = pts.positions.length / 3;
  const normals = new Float32Array(3 * n);
  for (let k = 0; k < n; k += 1) {
    const nv = decodeOctNormal(pts.normalOct[2 * k], pts.normalOct[2 * k + 1]);
    normals[3 * k] = nv[0];
    normals[3 * k + 1] = nv[1];
    normals[3 * k + 2] = nv[2];
  }
  const color = shadeResult(res, camera, { format: 1, normals }, opts.lightDirWorld, { ambient: opts.ambient });
  return { ...res, color };
}
