// T04.9 점 통계 도구. 점 수·경계 상자·밀도·형식을 계산한다.
import { PointsError } from '../../contracts/points/index.mjs';

/** @typedef {import('../../contracts/points/index.mjs').Point27Cloud} Point27Cloud */
/** @typedef {import('../../contracts/points/index.mjs').Gauss56Cloud} Gauss56Cloud */

/**
 * 점군의 통계: 점 수, 형식, 최소·최대 좌표, 점/m² 밀도.
 *
 * 입력 검증 정책(거부 방식): 입력이 null/객체 아님이면 PointsError('format'),
 * positions 가 없거나 길이가 3의 배수가 아니거나 count*3 과 다르면 PointsError('size'),
 * NaN·±Infinity 좌표가 하나라도 있으면 PointsError('range') 로 거부한다.
 * 비유한 점을 건너뛰는 방식은 쓰지 않는다(조용히 빠지지 않는다).
 * 따라서 NaN 위치와 무관하게 결과가 같고, 반환값에는 NaN 이 섞이지 않는다.
 * @param {Point27Cloud | Gauss56Cloud} cloud
 * @returns {{count: number, format: number, min: number[] | null, max: number[] | null, densityPerM2: number | null}}
 */
export function pointStats(cloud) {
  if (cloud === null || typeof cloud !== 'object') {
    throw new PointsError('format', 'cloud must be an object');
  }
  const { count, format, positions } = cloud;
  if (positions == null || typeof positions.length !== 'number') {
    throw new PointsError('size', 'positions is missing');
  }
  // count 와 positions.length/3 대조
  if (positions.length % 3 !== 0 || positions.length / 3 !== count) {
    throw new PointsError('size', `count ${count} does not match positions.length/3 (${positions.length}/3)`);
  }

  // 점이 없으면 min·max 는 null
  if (count === 0) {
    return {
      count: 0,
      format,
      min: null,
      max: null,
      densityPerM2: null,
    };
  }

  // 최소·최대 좌표 계산 (positions 는 3n, [x0,y0,z0, x1,y1,z1, ...])
  // 초기값은 ±Infinity, 첫 점을 특별 취급하지 않는다
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new PointsError('range', `non-finite coordinate at point ${i / 3}`);
    }

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  // 밀도 계산: 면적 0이면 null
  let densityPerM2 = null;
  const areaXY = (maxX - minX) * (maxY - minY);
  if (areaXY > 0) {
    densityPerM2 = count / areaXY;
  }

  return {
    count,
    format,
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    densityPerM2,
  };
}
