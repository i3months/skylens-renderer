// 첫 프레임 시간 기준선. inputs.distDir(이미 빌드된 dist)의 inputs.entryPath(기본 상황판)를 http 로 서빙해 헤드리스 Chromium(소프트웨어 렌더)으로 5회 측정한다. 결과는 참고값이다.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireInput } from '../../../contracts/inputs/index.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { launchBrowser, serveDist, measureFirstFrame, resolveEntryPath, DEFAULT_CANVAS_SELECTOR, DEAD_RELAY_QUERY, DEVICE } from '../_common/browser.mjs';

export const RUNS = 5;

/** 중앙값. 빈 배열이면 오류. 짝수 개면 가운데 두 값의 평균. */
export function median(xs) {
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('median: 빈 입력');
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 표본 표준편차(ms). n-1 로 나눈 분산의 제곱근. 표본이 1개면 0. */
export function stddev(xs) {
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('stddev: 빈 입력');
  if (xs.length === 1) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

/** inputs.canvasSelector 를 검증해 돌려준다(없으면 상황판 3D 캔버스 기본값). */
export function resolveCanvasSelector(inputs) {
  const s = inputs?.canvasSelector ?? DEFAULT_CANVAS_SELECTOR;
  if (typeof s !== 'string' || !s.trim()) throw new Error(`inputs.canvasSelector 는 비어 있지 않은 CSS 선택자여야 함: ${String(s)}`);
  return s.trim();
}

export async function run({ outDir, commit, inputs, runs = RUNS, timeoutMs = 30000 } = {}) {
  const distDir = requireInput(inputs, 'distDir');
  const entryPath = resolveEntryPath(inputs);
  const canvasSelector = resolveCanvasSelector(inputs);
  const server = await serveDist(distDir, { entryPath });
  let browser;
  try {
    browser = await launchBrowser();
    const samples = [];
    let judged = canvasSelector;
    for (let i = 0; i < runs; i++) {
      const r = await measureFirstFrame(browser, server.url, { timeoutMs, canvasSelector });
      samples.push(r.ms);
      judged = r.canvas ?? judged;
    }
    const how = `playwright ${runs}회, 새 컨텍스트, dist 를 http 로 서빙해 ${entryPath}?${DEAD_RELAY_QUERY} 를 연다(ws 스트림 없이 부팅해 스캐폴드가 처음 그려지는 시점이며 접속→첫 프레임의 하한 참고값, 스트림 재생은 범위 밖), 3D 뷰 캔버스(선택자 ${canvasSelector}, 판정된 요소 ${judged}; 2D 미니맵 등 다른 캔버스는 제외)의 배경색과 다른 픽셀이 0.1% 이상 그려진 첫 rAF 시각(탐색 시작 기준), 소프트웨어 렌더라 참고값`;
    const records = assertRecords([
      { metric: 'first_frame.median', value: median(samples), unit: 'ms', device: DEVICE, method: `${how}; 중앙값`, commit, samples },
      { metric: 'first_frame.stddev', value: stddev(samples), unit: 'ms', device: DEVICE, method: `${how}; 표본 표준편차(n-1)`, commit, samples },
    ]);
    if (outDir) {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, 'first_frame.json'), JSON.stringify(records, null, 2) + '\n');
    }
    return records;
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}
