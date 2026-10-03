// 대규모 장면 생성(T05.5). 250만 점 규모 성능 시험 씬.
// x,z∈[-250,250] 평지(y=0, 법선 위쪽)에 시드 기반 무늬 색 점.

import { mulberry32, makeResult, checkCount, normalizeSeed, checkFormat, FORMAT_POINT27 } from '../../../contracts/scenes/index.mjs';

/**
 * 250만 점 규모 장면 생성.
 * @param {{seed: number, count?: number, format?: 1|2}} opts
 * @returns {import('../../../contracts/scenes/index.mjs').SceneResult}
 */
export function generate(opts = {}) {
  const count = checkCount(opts.count, 2500000);
  const seed = normalizeSeed(opts.seed);
  const format = checkFormat(opts.format);
  const rng = mulberry32(seed);

  // 경계 설정: x,z ∈ [-250, 250], y = 0
  const bounds = { min: [-250, 0, -250], max: [250, 0, 250] };
  const areaM2 = 500 * 500; // 250,000 m²

  const positions = new Float32Array(3 * count);
  const normals = new Float32Array(3 * count);
  const colors = new Uint8Array(3 * count);

  // 배치: nx 열 × nz 행 층화 격자(칸이 500 m 전체를 빈틈없이 덮고, 점은 자기 칸 안에서만 지터).
  // 격자에 못 담은 나머지(< nx 점)는 전 구역에 균일 난수로 둔다. 그래서 어느 가장자리도 비지 않는다.
  const nx = Math.max(1, Math.floor(Math.sqrt(count)));
  const nz = Math.floor(count / nx);
  const cw = 500 / nx, ch = 500 / Math.max(1, nz);
  const gridCount = nx * nz;

  for (let idx = 0; idx < count; idx++) {
    let x, z;
    if (idx < gridCount) {
      const i = idx % nx, j = (idx / nx) | 0;
      x = -250 + (i + rng()) * cw;
      z = -250 + (j + rng()) * ch;
    } else {
      x = -250 + rng() * 500;
      z = -250 + rng() * 500;
    }
    // 부동소수 오차로 경계를 넘지 않게 고정
    x = Math.min(250, Math.max(-250, x));
    z = Math.min(250, Math.max(-250, z));

    positions[3 * idx] = x;
    positions[3 * idx + 1] = 0;
    positions[3 * idx + 2] = z;
    normals[3 * idx + 1] = 1; // 법선 위쪽 (0, 1, 0)

    // 색: 체크보드 무늬 + 노이즈
    const checker = ((Math.floor(x / 10) + Math.floor(z / 10)) & 1) ? 200 : 100;
    const noise = (rng() * 40 - 20) | 0;
    const v = Math.max(0, Math.min(255, checker + noise));
    colors[3 * idx] = v;
    colors[3 * idx + 1] = v;
    colors[3 * idx + 2] = v;
  }

  const cloud27 = { format: FORMAT_POINT27, count, positions, normals, colors };
  const truth = { bounds, areaM2 };
  return makeResult('large', seed, format, cloud27, truth);
}
