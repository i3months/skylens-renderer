// 메모리 기준선 (T01.7). inputs.distDir 를 first_frame 과 같은 방식(http, 같은 인자·device)으로 열어 첫 프레임 뒤 측정한다. 참고값이다.
//   heap.js_used      V8 힙 사용량(JSHeapUsedSize, GC 후). TypedArray·WebGL 버퍼는 힙 밖이라 포함되지 않는다. 탭 전체 메모리(S3)와 대응시키지 않는다.
//   heap.process_rss  브라우저 프로세스 트리(브라우저·렌더러·GPU 등) RSS 합. /proc 이 있는 Linux 에서만 기록한다.
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { requireInput } from '../../../contracts/inputs/index.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { launchBrowser, serveDist, measureFirstFrame, resolveEntryPath, DEAD_RELAY_QUERY, DEVICE } from '../_common/browser.mjs';

export const RUNS = 5;
export const METRIC = 'heap.js_used';
export const METRIC_RSS = 'heap.process_rss';

/** 중앙값 순수 함수. 짝수 개면 가운데 두 값의 평균. 입력은 바꾸지 않는다. */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('median: 빈 입력');
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** /proc 로 tag 를 명령행에 가진 프로세스와 그 자손의 RSS(바이트) 합. /proc 이 없으면 null. */
export function processTreeRss(tag) {
  let pids;
  try { pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return null; }
  const ppid = new Map();
  let root = null;
  for (const p of pids) {
    try {
      const st = readFileSync(`/proc/${p}/stat`, 'utf8');
      ppid.set(p, st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      if (root === null && readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(tag)) root = p;
    } catch { /* 사라진 프로세스 */ }
  }
  if (root === null) return null;
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, pp] of ppid) if (!tree.has(p) && tree.has(pp)) { tree.add(p); grew = true; }
  }
  let rss = 0;
  for (const p of tree) {
    try { rss += Number(readFileSync(`/proc/${p}/statm`, 'utf8').split(' ')[1]) * 4096; } catch { /* 사라진 프로세스 */ }
  }
  return rss;
}

async function measureOnce(browser, url, tag, timeoutMs) {
  const { after } = await measureFirstFrame(browser, url, {
    timeoutMs,
    after: async (page) => { // 첫 프레임 직후 같은 페이지에서 측정
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const js = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value;
      if (!Number.isFinite(js)) throw new Error('JSHeapUsedSize 를 얻지 못함');
      return { js, rss: processTreeRss(tag) };
    },
  });
  return after;
}

export async function run({ commit, inputs, runs = RUNS, timeoutMs = 30000 } = {}) {
  const distDir = requireInput(inputs, 'distDir');
  const entryPath = resolveEntryPath(inputs);
  const server = await serveDist(distDir, { entryPath });
  const tag = `--skylens-bench-tag=${randomUUID()}`;
  let browser;
  try {
    browser = await launchBrowser([tag]);
    const js = [];
    const rss = [];
    for (let i = 0; i < runs; i++) {
      const r = await measureOnce(browser, server.url, tag, timeoutMs);
      js.push(r.js);
      if (r.rss !== null) rss.push(r.rss);
    }
    const base = { unit: 'B', device: DEVICE, commit };
    const how = `playwright ${runs}회, dist 를 http 로 서빙해 ${entryPath}?${DEAD_RELAY_QUERY} 를 연다(ws 스트림 없이 부팅한 스캐폴드, 스트림 재생은 범위 밖), 첫 프레임 뒤 측정`;
    const records = [{ ...base, metric: METRIC, value: median(js), method: `${how}; CDP JSHeapUsedSize(GC 후) 중앙값. V8 힙만이며 TypedArray·WebGL 버퍼 제외`, samples: js }];
    if (rss.length === runs) {
      records.push({ ...base, metric: METRIC_RSS, value: median(rss), method: `${how}; 브라우저 프로세스 트리 RSS 합(/proc) 중앙값`, samples: rss });
    }
    return assertRecords(records);
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}
