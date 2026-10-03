// 대규모 장면 생성(T05.5). 250만 점 규모 성능 시험 씬.
// x,z∈[-250,250] 평지(y=0, 법선 위쪽)에 시드 기반 무늬 색 점.

import { mulberry32, subSeed, makeResult, FORMAT_POINT27, FORMAT_GAUSS56 } from '../../../contracts/scenes/index.mjs';

/**
 * 250만 점 규모 장면 생성.
 * @param {{seed: number, count?: number, format?: 1|2}} opts
 * @returns {import('../../../contracts/scenes/index.mjs').SceneResult}
 */
export function generate(opts) {
  const count = opts.count ?? 2500000;
  const seed = opts.seed >>> 0;
  const rng = mulberry32(seed);

  // 경계 설정: x,z ∈ [-250, 250], y = 0
  const bounds = { min: [-250, 0, -250], max: [250, 0, 250] };
  const areaM2 = 500 * 500; // 250,000 m²

  // 메모리: 열 배열(Float32Array), 한 번에 할당.
  const positions = new Float32Array(3 * count);
  const normals = new Float32Array(3 * count);
  const colors = new Uint8Array(3 * count);

  // 그리드 기반 분포(시드로 약간의 지터 추가).
  const pointsPerMeter = Math.sqrt(count / areaM2);
  const spacing = 1 / pointsPerMeter;
  const gridSize = Math.ceil(500 / spacing);
  let idx = 0;

  for (let i = 0; i < gridSize && idx < count; i++) {
    for (let j = 0; j < gridSize && idx < count; j++) {
      const x = -250 + i * spacing + (rng() - 0.5) * spacing * 0.5;
      const z = -250 + j * spacing + (rng() - 0.5) * spacing * 0.5;

      // 경계 범위 내 보정
      if (x < -250 || x > 250 || z < -250 || z > 250) continue;

      // 위치
      positions[3 * idx] = x;
      positions[3 * idx + 1] = 0;
      positions[3 * idx + 2] = z;

      // 법선: 위쪽 (0, 1, 0)
      normals[3 * idx] = 0;
      normals[3 * idx + 1] = 1;
      normals[3 * idx + 2] = 0;

      // 색: 체크보드 무늬 + 노이즈
      const cellX = Math.floor(x / 10);
      const cellZ = Math.floor(z / 10);
      const checker = ((cellX + cellZ) & 1) ? 200 : 100;
      const noise = (rng() * 40 - 20) | 0; // -20~20 범위
      const colorVal = Math.max(0, Math.min(255, checker + noise));

      colors[3 * idx] = colorVal;
      colors[3 * idx + 1] = colorVal;
      colors[3 * idx + 2] = colorVal;

      idx++;
    }
  }

  // 정확한 count 맞추기: idx가 count보다 적으면 나머지 채우기
  if (idx < count) {
    for (let i = idx; i < count; i++) {
      const x = -250 + rng() * 500;
      const z = -250 + rng() * 500;

      positions[3 * i] = x;
      positions[3 * i + 1] = 0;
      positions[3 * i + 2] = z;

      normals[3 * i] = 0;
      normals[3 * i + 1] = 1;
      normals[3 * i + 2] = 0;

      const cellX = Math.floor(x / 10);
      const cellZ = Math.floor(z / 10);
      const checker = ((cellX + cellZ) & 1) ? 200 : 100;
      const noise = (rng() * 40 - 20) | 0;
      const colorVal = Math.max(0, Math.min(255, checker + noise));

      colors[3 * i] = colorVal;
      colors[3 * i + 1] = colorVal;
      colors[3 * i + 2] = colorVal;
    }
  }

  const cloud27 = { format: FORMAT_POINT27, count, positions, normals, colors };
  const truth = { bounds, areaM2 };

  return makeResult('large', seed, opts.format ?? FORMAT_POINT27, cloud27, truth);
}
