// 대규모 점군 래스터라이제이션 성능 측정(T06.11).
// 250만 점 생성, 정면 카메라로 1회 렌더링의 CPU 시간을 3회 반복 측정한다.
// 중앙값, 최소값, 최대값, 빈 픽셀 비율을 기록한다.

import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { generate } from '../../fixtures/scenes/large/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';
import { project } from '../../server/raster_ref/project/index.mjs';
import { splatRadiusPx, splatPixels } from '../../server/raster_ref/splat/index.mjs';
import { emptyRatio } from '../../server/metrics/psnr/index.mjs';
import { assertRecords, serialize } from '../../contracts/metrics/index.mjs';

/** 측정 반복 횟수(워밍업 제외). */
export const RUNS = 5;
/** 측정 전에 버리는 워밍업 렌더 횟수(JIT·힙 확장 효과를 시간에서 뺀다). */
export const WARMUP = 1;
/** 측정 케이스. small_disc 는 기존 기준 케이스(원판 반경이 1 px 미만), large_disc 는 큰 원판 경로(반경 수 px, 점당 십수 픽셀)를 잰다(한 번이 오래 걸려 maxRuns 로 반복을 제한). */
export const CASES = Object.freeze([
  { name: 'small_disc', prefix: 'raster_ref_bench', pointSizeM: 1.0 },
  { name: 'large_disc', prefix: 'raster_ref_bench.large_disc', pointSizeM: 3.0, maxRuns: 3 },
]);

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
 * 점 하나가 평균 몇 픽셀을 덮는지 센다(화면과 겹치는 점만, stride 개마다 하나를 표본으로).
 * 큰 원판 경로가 실제로 측정되는지 확인하는 지표다. 시간 측정 밖에서 한 번만 호출한다.
 */
export function meanPixelsPerPoint(camera, cloud, pointSizeM, stride = 16) {
  const pos = cloud.positions;
  const n = pos.length / 3;
  let pts = 0;
  let pixels = 0;
  for (let k = 0; k < n; k += stride) {
    const { u, v, d } = project(camera, [pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]]);
    if (!(d > 0) || !Number.isFinite(u) || !Number.isFinite(v)) continue;
    const covered = splatPixels(u, v, splatRadiusPx(camera, d, pointSizeM), camera.width, camera.height).length;
    pts += 1;
    pixels += covered;
  }
  return pts === 0 ? 0 : pixels / pts;
}

/**
 * 케이스 하나를 측정한다: 워밍업 warmup 회(버림) 뒤 runs 회의 시간(ms)과 마지막 측정 결과의 빈 픽셀 비율.
 * 마지막 측정 렌더의 결과를 그대로 쓰므로 추가 렌더는 없다.
 */
export function measureCase(camera, cloud, pointSizeM, { runs, warmup }) {
  for (let i = 0; i < warmup; i += 1) renderPoints(camera, cloud, { pointSizeM, validate: false });
  const samples = [];
  let last = null;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    last = renderPoints(camera, cloud, { pointSizeM, validate: false });
    samples.push(performance.now() - t0);
  }
  return { samples, emptyPixelRatio: emptyRatio(last) };
}

/**
 * 장면 bounds 를 비스듬히 내려다보는 카메라로 CASES 의 각 케이스를 측정해 지표 레코드를 돌려준다.
 * count 로 점 수를 줄일 수 있다(시험용). 기본 250만 점.
 */
export async function run({ skylensDir, outDir, commit, runs = RUNS, warmup = WARMUP, count = 2500000, cases = CASES } = {}) {
  const scene = generate({ seed: 1, count, format: 1 });
  const cloud = scene.cloud;
  const bounds = scene.truth.bounds;
  const WIDTH = 1280;
  const HEIGHT = 720;
  const camera = makeCamera(bounds.min, bounds.max, WIDTH, HEIGHT);

  const all = [];
  for (const cs of cases) {
    const caseRuns = Math.min(runs, cs.maxRuns ?? runs); // 큰 원판 케이스는 한 번이 오래 걸려 반복 수 상한이 있다
    const { samples, emptyPixelRatio } = measureCase(camera, cloud, cs.pointSizeM, { runs: caseRuns, warmup });
    const med = median(samples);
    const ppp = meanPixelsPerPoint(camera, cloud, cs.pointSizeM);
    const method = `${count} 점(seed=1, format=1) 생성, 비스듬히 내려다보는 카메라(bounds 보기, ${WIDTH}×${HEIGHT}), `
      + `워밍업 ${warmup} 회 버린 뒤 ${caseRuns} 회 반복 renderPoints(pointSizeM=${cs.pointSizeM}), performance.now() 로 CPU 시간 측정(ms)`;
    const base = { device: 'cpu', commit };
    all.push(
      { metric: `${cs.prefix}.render_time.median`, value: med, unit: 'ms', method: `${method}; 중앙값`, samples, ...base },
      { metric: `${cs.prefix}.render_time.min`, value: Math.min(...samples), unit: 'ms', method: `${method}; 최솟값`, samples, ...base },
      { metric: `${cs.prefix}.render_time.max`, value: Math.max(...samples), unit: 'ms', method: `${method}; 최댓값`, samples, ...base },
      { metric: `${cs.prefix}.empty_pixel_ratio`, value: emptyPixelRatio, unit: 'ratio', method: `${method}; 빈 픽셀(마지막 측정 렌더 결과) 비율`, ...base },
      { metric: `${cs.prefix}.mean_pixels_per_point`, value: ppp, unit: 'px', method: `${method}; 화면과 겹치는 점이 평균 덮는 픽셀 수(점 16개마다 표본)`, ...base },
    );
  }
  const records = assertRecords(all);

  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'raster_ref_bench.json'), serialize(records));
  }

  return records;
}
