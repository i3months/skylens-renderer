// 메모리 기준선. inputs.distDir 를 first_frame 과 같은 방식(http, 같은 인자·device)으로 열어 첫 프레임 뒤 측정한다. 참고값이다.
//   heap.js_used      V8 힙 사용량(JSHeapUsedSize, GC 후). TypedArray·WebGL 버퍼는 힙 밖이라 포함되지 않는다. 탭 전체 메모리(S3)와 대응시키지 않는다.
//   heap.process_pss  브라우저 프로세스 트리(브라우저·렌더러·GPU 등) 메모리 합. /proc/<pid>/smaps_rollup 의 Pss(공유 페이지를 나눠 셈)를 쓰고,
//                     읽을 수 없는 프로세스는 statm RSS(시스템 페이지 크기 곱)로 폴백한다. 어느 쪽을 썼는지 method 에 기록하고, 섞이면 경고를 남긴다.
//                     /proc 이 있는 Linux 에서만, 센 프로세스가 1개 이상일 때만 기록한다. 첫 측정 1회는 워밍업으로 버리고 나머지 runs 회만 보고한다.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { requireInput } from '../../../contracts/inputs/index.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { launchBrowser, serveDist, measureFirstFrame, resolveEntryPath, assertOptionalInputKeys, DEFAULT_CANVAS_SELECTOR, DEAD_RELAY_QUERY, DEVICE } from '../_common/browser.mjs';

export const RUNS = 5;
export const METRIC = 'heap.js_used';
export const METRIC_PSS = 'heap.process_pss';

/** 중앙값 순수 함수. 짝수 개면 가운데 두 값의 평균. 입력은 바꾸지 않는다. */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('median: 빈 입력');
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

let pageSizeCache;
/** 시스템 페이지 크기(바이트). getconf PAGESIZE, 실패하면 4096. */
export function systemPageSize() {
  if (pageSizeCache === undefined) {
    let n = NaN;
    try { n = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8', timeout: 5000 }).trim()); } catch { /* getconf 없음 */ }
    pageSizeCache = Number.isInteger(n) && n > 0 ? n : 4096;
  }
  return pageSizeCache;
}

/** smaps_rollup 본문에서 Pss(바이트). 없으면 null. */
export function parsePss(text) {
  const m = /^Pss:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) * 1024 : null;
}

/** /proc 로 tag 를 명령행에 가진 프로세스와 그 자손의 메모리 합. /proc 이 없으면 null.
 *  { bytes, pssProcs, rssProcs }: 프로세스마다 Pss 를 쓰고 읽지 못하면 RSS(statm × 페이지 크기)로 폴백한다.
 *  procRoot 는 /proc 대신 읽을 디렉터리(테스트가 smaps·statm 을 읽을 수 없는 프로세스를 주입하는 용도). */
export function processTreeMemory(tag, { procRoot = '/proc' } = {}) {
  let pids;
  try { pids = readdirSync(procRoot).filter((d) => /^\d+$/.test(d)); } catch { return null; }
  const ppid = new Map();
  let root = null;
  for (const p of pids) {
    try {
      const st = readFileSync(`${procRoot}/${p}/stat`, 'utf8');
      ppid.set(p, st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      if (root === null && readFileSync(`${procRoot}/${p}/cmdline`, 'utf8').includes(tag)) root = p;
    } catch { /* 사라진 프로세스 */ }
  }
  if (root === null) return null;
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, pp] of ppid) if (!tree.has(p) && tree.has(pp)) { tree.add(p); grew = true; }
  }
  const page = systemPageSize();
  let bytes = 0, pssProcs = 0, rssProcs = 0;
  for (const p of tree) {
    let pss = null;
    try { pss = parsePss(readFileSync(`${procRoot}/${p}/smaps_rollup`, 'utf8')); } catch { /* 읽기 불가 → RSS 폴백 */ }
    if (pss !== null) { bytes += pss; pssProcs++; continue; }
    try {
      const rss = Number(readFileSync(`${procRoot}/${p}/statm`, 'utf8').split(' ')[1]) * page;
      if (!Number.isFinite(rss) || rss < 0) continue; // statm 이 깨졌거나(NaN) 음수면 합산하지 않고 이 프로세스를 건너뛴다
      bytes += rss; rssProcs++;
    } catch { /* 사라진 프로세스 */ }
  }
  if (pssProcs + rssProcs === 0) return null; // 하나도 읽지 못했으면 0 B 를 값으로 내지 않는다
  return { bytes, pssProcs, rssProcs };
}

/** processTreeMemory 의 바이트 합만. /proc 이 없으면 null. */
export function processTreeRss(tag) {
  return processTreeMemory(tag)?.bytes ?? null;
}

/** 메모리 합의 측정 방식 문구(method 용). 센 프로세스가 0개면 null(기록 생략 신호). */
export function memoryMethodText({ pssProcs, rssProcs }) {
  if (pssProcs + rssProcs === 0) return null;
  if (rssProcs === 0) return `PSS 사용(/proc/<pid>/smaps_rollup Pss 합, 공유 페이지 중복 제거, ${pssProcs}개 프로세스)`;
  if (pssProcs === 0) return `PSS 미사용: smaps_rollup 을 읽지 못해 RSS(statm × 페이지 ${systemPageSize()} B)로 폴백, 공유 페이지가 중복 계산될 수 있음(${rssProcs}개 프로세스)`;
  return `경고: PSS·RSS 방식이 섞임 — ${pssProcs}개 프로세스는 Pss, ${rssProcs}개는 RSS(statm × 페이지 ${systemPageSize()} B)로 폴백. 공유 페이지 중복 계산 정도가 달라 다른 기록과 직접 비교하지 말 것`;
}

async function measureOnce(browser, url, tag, timeoutMs, canvasSelector, readMemory = processTreeMemory) {
  const { after } = await measureFirstFrame(browser, url, {
    timeoutMs,
    canvasSelector,
    after: async (page) => { // 첫 프레임 직후 같은 페이지에서 측정
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const js = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value;
      if (!Number.isFinite(js)) throw new Error('JSHeapUsedSize 를 얻지 못함');
      return { js, mem: readMemory(tag) };
    },
  });
  return after;
}

/** deps 는 테스트 주입용: launch(브라우저 실행), measureOnce(1회 측정, 마지막 인자로 메모리 읽기 함수를 받는다), readMemory(tag → processTreeMemory 형 결과). */
export async function run({ commit, inputs, runs = RUNS, timeoutMs = 30000, deps = {} } = {}) {
  const { launch = launchBrowser, measureOnce: measure = measureOnce, readMemory = processTreeMemory } = deps;
  const distDir = requireInput(inputs, 'distDir');
  const entryPath = resolveEntryPath(inputs);
  assertOptionalInputKeys(inputs);
  const canvasSelector = inputs?.canvasSelector ?? DEFAULT_CANVAS_SELECTOR;
  if (typeof canvasSelector !== 'string' || !canvasSelector.trim()) throw new Error(`inputs.canvasSelector 는 비어 있지 않은 CSS 선택자여야 함: ${String(canvasSelector)}`);
  const server = await serveDist(distDir, { entryPath });
  const tag = `--skylens-bench-tag=${randomUUID()}`;
  let browser;
  try {
    browser = await launch([tag]);
    const js = [];
    const pss = [];
    const mems = [];
    await measure(browser, server.url, tag, timeoutMs, canvasSelector.trim(), readMemory); // 워밍업 1회는 버린다(첫 부팅의 캐시·프로세스 구성 영향)
    for (let i = 0; i < runs; i++) {
      const r = await measure(browser, server.url, tag, timeoutMs, canvasSelector.trim(), readMemory);
      js.push(r.js);
      if (r.mem !== null) { pss.push(r.mem.bytes); mems.push(r.mem); }
    }
    const base = { unit: 'B', device: DEVICE, commit };
    const how = `playwright 워밍업 1회 버린 뒤 ${runs}회, dist 를 http 로 서빙해 ${entryPath}?${DEAD_RELAY_QUERY} 를 연다(ws 스트림 없이 부팅한 스캐폴드, 스트림 재생은 범위 밖), 첫 프레임(3D 뷰 캔버스 ${canvasSelector} 기준) 뒤 측정`;
    const records = [{ ...base, metric: METRIC, value: median(js), method: `${how}; CDP JSHeapUsedSize(GC 후) 중앙값. V8 힙만이며 TypedArray·WebGL 버퍼 제외`, samples: js }];
    if (pss.length === runs) {
      const text = memoryMethodText({ pssProcs: Math.min(...mems.map((m) => m.pssProcs)), rssProcs: Math.max(...mems.map((m) => m.rssProcs)) });
      if (text !== null) records.push({ ...base, metric: METRIC_PSS, value: median(pss), method: `${how}; 브라우저 프로세스 트리 메모리 합(/proc) 중앙값. ${text}`, samples: pss });
    }
    return assertRecords(records);
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}
