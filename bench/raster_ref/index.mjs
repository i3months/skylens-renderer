// 대규모 점군 래스터라이제이션 성능 측정(T06.11).
// 250만 점 생성, 정면 카메라로 1회 렌더링의 CPU 시간을 3회 반복 측정한다.
// 중앙값, 최소값, 최대값, 빈 픽셀 비율을 기록한다.

import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { generate } from '../../fixtures/scenes/large/index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';
import { emptyRatio } from '../../server/metrics/psnr/index.mjs';
import { assertRecords, serialize } from '../../contracts/metrics/index.mjs';

/** 측정 반복 횟수. */
export const RUNS = 3;

/** 중앙값 계산. */
export function median(xs) {
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('median: 빈 입력');
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 장면 bounds 를 바라보는 정면 카메라를 생성한다.
 * 좌표계: 세계(ENU: +x 오른쪽, +y 위, +z 뒤) → 카메라(OpenCV: +x 오른쪽, +y 아래, +z 앞)
 * @param {number[]} min bounds 최솟값 [x, y, z]
 * @param {number[]} max bounds 최댓값 [x, y, z]
 * @param {number} width 화상폭(픽셀)
 * @param {number} height 화상높이(픽셀)
 * @returns {import('../../contracts/raster/index.mjs').Camera}
 */
export function makeCamera(min, max, width, height) {
  const centerX = (min[0] + max[0]) / 2;
  const centerY = (min[1] + max[1]) / 2;
  const centerZ = (min[2] + max[2]) / 2;

  // 장면을 완전히 보도록 카메라를 배치한다.
  const rangeX = Math.max(Math.abs(max[0] - min[0]), 1);
  // y 는 0 범위(평면)일 수 있으므로, y 범위가 0이면 x 범위의 일부를 사용
  const rangeY = Math.max(Math.abs(max[1] - min[1]), Math.max(rangeX, 1) * 0.5);

  // 카메라 거리: 종횡비를 고려해 장면을 화면에 맞춘다.
  // 수직 FOV 는 약 50도. fy = height / (2 * tan(fov_y / 2))
  const fov_y_rad = (50 * Math.PI) / 180;
  const fy = height / (2 * Math.tan(fov_y_rad / 2));
  const fx = fy;

  // 높이(y) 범위로 거리 계산: 높이 범위가 보이려면
  // height/2 = rangeY * fy / dist -> dist = rangeY * fy * 2 / height
  const distFromHeight = rangeY > 0 ? (rangeY * fy * 2) / height : 1;
  // 너비(x) 범위로 거리 계산: 너비 범위가 보이려면
  // width/2 = rangeX * fx / dist -> dist = rangeX * fx * 2 / width
  const distFromWidth = rangeX > 0 ? (rangeX * fx * 2) / width : 1;

  // 두 조건을 모두 만족하는 거리 (더 큰 값)
  const dist = Math.max(distFromHeight, distFromWidth, 100);

  // 정면 카메라: 세계 좌표의 +z 방향(뒤)에서 바라본다.
  // 카메라는 centerZ + dist (뒤쪽)에 배치된다.
  const camWorldPos = [centerX, centerY, centerZ + dist];

  // 카메라 내재 파라미터
  const K = {
    fx: fx,
    fy: fy,
    cx: width / 2,
    cy: height / 2,
  };

  // 회전: 정면 정렬(front-aligned)
  // ENU(+x right, +y up, +z back) → OpenCV(+x right, +y down, +z forward)
  // 회전은 y를 반대로, z를 반대로 하는 것이다.
  // R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]] (행 우선)
  const R = [1, 0, 0, 0, -1, 0, 0, 0, -1];

  // 변환: X_c = R·X_w + t
  // t = X_c_eye - R·camWorldPos
  // 카메라 원점(카메라 좌표): X_c_eye = [0, 0, 0]
  // t = [0, 0, 0] - R·camWorldPos
  const t = [
    -(R[0] * camWorldPos[0] + R[1] * camWorldPos[1] + R[2] * camWorldPos[2]),
    -(R[3] * camWorldPos[0] + R[4] * camWorldPos[1] + R[5] * camWorldPos[2]),
    -(R[6] * camWorldPos[0] + R[7] * camWorldPos[1] + R[8] * camWorldPos[2]),
  ];

  return { width, height, K, R, t };
}

/**
 * 사용자 정의 카메라 없이 기본 정면 카메라를 생성한다.
 * 장면 bounds 를 바라본다.
 */
export async function run({ skylensDir, outDir, commit, runs = RUNS } = {}) {
  // 장면 생성: 250 만 점, seed=1, format=1
  const scene = generate({ seed: 1, count: 2500000, format: 1 });
  const cloud = scene.cloud;
  const bounds = scene.truth.bounds;

  // 카메라 설정: 1280x720, 정면
  const WIDTH = 1280;
  const HEIGHT = 720;
  const camera = makeCamera(bounds.min, bounds.max, WIDTH, HEIGHT);

  // 측정: 3회 반복
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    const result = renderPoints(camera, cloud, { pointSizeM: 1.0, validate: false });
    const t1 = performance.now();
    const ms = t1 - t0;
    samples.push(ms);
  }

  // 통계 계산
  const med = median(samples);
  const minVal = Math.min(...samples);
  const maxVal = Math.max(...samples);

  // 실제 렌더링(최종 값용): 마지막 회차 결과를 사용해 빈 픽셀 비율 계산
  const result = renderPoints(camera, cloud, { pointSizeM: 1.0, validate: false });
  const emptyPixelRatio = emptyRatio(result);

  const method = `
    250 만 점(seed=1, format=1) 생성, 정면 카메라(bounds 보기, 1280×720),
    ${runs} 회 반복 renderPoints(cloud, camera, pointSizeM=1.0),
    성능.now() 로 CPU 시간 측정 (ms)
  `.replace(/\s+/g, ' ').trim();

  const records = assertRecords([
    {
      metric: 'raster_ref_bench.render_time.median',
      value: med,
      unit: 'ms',
      device: 'cpu',
      method: `${method}; 중앙값`,
      commit,
      samples,
    },
    {
      metric: 'raster_ref_bench.render_time.min',
      value: minVal,
      unit: 'ms',
      device: 'cpu',
      method: `${method}; 최솟값`,
      commit,
      samples,
    },
    {
      metric: 'raster_ref_bench.render_time.max',
      value: maxVal,
      unit: 'ms',
      device: 'cpu',
      method: `${method}; 최댓값`,
      commit,
      samples,
    },
    {
      metric: 'raster_ref_bench.empty_pixel_ratio',
      value: emptyPixelRatio,
      unit: 'ratio',
      device: 'cpu',
      method: `${method}; 빈 픽셀(렌더 결과) 비율`,
      commit,
    },
  ]);

  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'raster_ref_bench.json'), serialize(records));
  }

  return records;
}
