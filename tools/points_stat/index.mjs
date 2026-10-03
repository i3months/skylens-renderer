// T04.9 점 통계 도구. 점 수·경계 상자·밀도·형식을 계산한다.
/** @typedef {import('../../contracts/points/index.mjs').Point27Cloud} Point27Cloud */
/** @typedef {import('../../contracts/points/index.mjs').Gauss56Cloud} Gauss56Cloud */

/**
 * 점군의 통계: 점 수, 형식, 최소·최대 좌표, 점/m² 밀도.
 * @param {Point27Cloud | Gauss56Cloud} cloud
 * @returns {{count: number, format: number, min: number[] | null, max: number[] | null, densityPerM2: number | null}}
 */
export function pointStats(cloud) {
  const { count, format, positions } = cloud;

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
  let minX = positions[0];
  let maxX = positions[0];
  let minY = positions[1];
  let maxY = positions[1];
  let minZ = positions[2];
  let maxZ = positions[2];

  for (let i = 3; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];

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
