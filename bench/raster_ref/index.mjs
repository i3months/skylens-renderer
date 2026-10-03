// 대규모 점군 래스터라이제이션 성능 측정(T06.11).
// 250만 점 생성, 정면 카메라로 1회 렌더링의 CPU 시간을 3회 반복 측정한다.
// 중앙값, 최소값, 최대값, 빈 픽셀 비율을 기록한다.

import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { generate } from '../../fixtures/scenes/large/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
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
 * 장면 bounds 를 비스듬히 내려다보는 카메라를 만든다(평면 장면을 옆에서 보면 거의 빈 영상이 되므로).
 * GL 규약 시점을 tools/render_views 의 viewpointToCamera 로 계약 카메라(OpenCV)로 바꾼다.
 */
export function makeCamera(min, max, width, height) {
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const r = Math.max(max[0] - min[0], max[2] - min[2], 1);
  return viewpointToCamera({
    eye: [c[0], c[1] + 0.8 * r, c[2] + 0.8 * r],
    target: c,
    up: [0, 1, 0],
    width,
    height,
    fov_y_deg: 50,
  });
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
