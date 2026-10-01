// JS 힙 사용량 기준선 측정 (T01.7). 헤드리스 Chromium 은 참고값이다.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

export const RUNS = 5;
export const METRIC = 'heap.js_used_median';
export const CHROMIUM_PATH = process.env.SKYLENS_CHROMIUM || '/opt/pw-browsers/chromium';

/** 중앙값 순수 함수. 짝수 개면 가운데 두 값의 평균. 입력은 바꾸지 않는다. */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('median: 빈 입력');
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** playwright 를 찾는다. 없으면 null (의존성은 추가하지 않는다). */
export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {}
  const roots = [process.env.SKYLENS_PLAYWRIGHT_DIR, '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const dir of roots) {
    try {
      const mod = createRequire(join(dir, 'x.js'))(dir);
      if (mod?.chromium) return mod;
    } catch {}
  }
  return null;
}

/** 브라우저 테스트를 돌릴 수 없는 사유. 가능하면 null. */
export async function unavailableReason() {
  if (!existsSync(CHROMIUM_PATH)) return `Chromium 없음: ${CHROMIUM_PATH}`;
  if (!(await loadPlaywright())) return 'playwright 모듈을 찾을 수 없음';
  return null;
}

async function measureOnce(browser, url, settleMs) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(settleMs); // 안정화 대기
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.collectGarbage'); // 쓰레기 수거 뒤 측정
    const { metrics } = await cdp.send('Performance.getMetrics');
    const v = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value;
    if (!Number.isFinite(v)) throw new Error('JSHeapUsedSize 를 얻지 못함');
    return v;
  } finally {
    await page.close();
  }
}

export async function run({ skylensDir, outDir, commit, url, settleMs = 1000 } = {}) {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('playwright 모듈을 찾을 수 없음');
  const index = skylensDir ? join(skylensDir, 'index.html') : null;
  const target = url ?? (index && existsSync(index) ? pathToFileURL(index).href : null);
  if (!target) throw new Error('측정할 url 이 없음');
  const browser = await pw.chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: ['--enable-precise-memory-info', '--no-sandbox'],
  });
  try {
    const samples = [];
    for (let i = 0; i < RUNS; i++) samples.push(await measureOnce(browser, target, settleMs));
    return assertRecords([
      {
        metric: METRIC,
        value: median(samples),
        unit: 'B',
        device: 'headless-chromium (reference)',
        method: `CDP Performance.getMetrics JSHeapUsedSize, GC 후, ${RUNS}회 중앙값`,
        commit,
        samples,
      },
    ]);
  } finally {
    await browser.close();
  }
}
