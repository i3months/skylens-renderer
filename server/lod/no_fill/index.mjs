// T07.11 LOD 후 빈자리 보존: 원본과 LOD 점군을 같은 카메라·같은 참조 래스터라이저로 그려 빈 픽셀 비율을 비교한다.
// LOD 는 점을 줄이기만 하고 빈자리(지붕·물처럼 점이 없는 곳)를 메우지 않아야 한다(skylens 원칙).
import { assertCloud } from '../../../contracts/lod/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { emptyRatio } from '../../metrics/psnr/index.mjs';

const ERR = 'lod:';

/**
 * 두 점군을 같은 카메라로 렌더해 빈 픽셀 비율을 구하고, 차이가 허용 이내인지 알린다.
 * @param {object} cloud          원본 점군(format 1)
 * @param {object} selectedCloud  LOD 로 고른 점군(format 1)
 * @param {object} camera         raster 계약의 카메라
 * @param {{pointSizeM?: number, tolerance?: number}} [opts]
 *        pointSizeM: 점 원판 지름(m, 기본은 래스터라이저 기본값), tolerance: 허용 비율 차(기본 0 = 정확히 같아야 함)
 * @returns {{original: number, lod: number, equal: boolean}}
 */
export function emptyRatioPreserved(cloud, selectedCloud, camera, opts) {
  // 점 수 정의: positions.length/3 == count (어긋나면 명시 오류)
  assertCloud(cloud);
  assertCloud(selectedCloud);
  const tolerance = opts?.tolerance ?? 0;
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(`${ERR} tolerance 는 0 이상의 유한수: ${String(tolerance)}`);
  }
  const rOpts = opts?.pointSizeM === undefined ? undefined : { pointSizeM: opts.pointSizeM };
  const original = emptyRatio(renderPoints(camera, cloud, rOpts));
  const lod = emptyRatio(renderPoints(camera, selectedCloud, rOpts));
  return { original, lod, equal: Math.abs(original - lod) <= tolerance };
}
