// T12.5 '60만 점 구간 복호 중 메인 스레드 long task 0' 실측(옵트인, 헤드리스 Chromium).
// 벽시계에 기대므로 npm test 에서는 돌지 않는다: SKYLENS_WORKER_LONGTASK=1 일 때만 실행한다.
//   SKYLENS_WORKER_LONGTASK=1 node --test client/raster/loop/worker.browser.test.mjs
// Chromium·playwright 가 없으면 이유를 출력하고 skip 한다. SKYLENS_REQUIRE_GL=1 이면 skip 대신 실패한다.
// 방법: 60만 점 codec 1 조각을 만들어 로컬 http 로 내려주고, 페이지에서 실제 복호 Worker(worker.mjs)를 createDecodeWorkerClient 로 띄워
// 복호 → (uploadPiece 가 메인에서 하는) toGpuPlanes 까지 걸리는 동안 PerformanceObserver longtask 를 센다.
// 기준은 0 이다. 측정이 유효한지 보려고 같은 조각을 메인 스레드에서 동기 복호하는 대조도 재서 보고한다(대조가 0 이면 계측이 못 잡는 것).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packChunk } from '../../../server/asset/pack/index.mjs';
import { encodeChunk } from '../../../server/codec/chunk/index.mjs';
import { FORMAT_POINT27 } from '../../../contracts/asset/index.mjs';

const POINTS = 600_000;
const LONG_TASK_LIMIT = 0; // 성공 기준(T12.5). 측정에 맞춰 바꾸지 않는다.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const requireGl = process.env.SKYLENS_REQUIRE_GL === '1';
let skipReason = null;
if (process.env.SKYLENS_WORKER_LONGTASK !== '1') skipReason = '옵트인 시험: SKYLENS_WORKER_LONGTASK=1 로 켠다(벽시계 측정이라 npm test 에 넣지 않음)';

let chromium = null;
let browser = null;
if (!skipReason) {
  const require = createRequire(import.meta.url);
  for (const p of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { ({ chromium } = require(p)); break; } catch { /* 다음 후보 */ }
  }
  if (!chromium) skipReason = 'playwright 모듈을 찾지 못함';
}
if (!skipReason) {
  try {
    browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  } catch (e) { skipReason = `Chromium 실행 실패: ${e.message.split('\n')[0]}`; }
}
if (skipReason) {
  console.log(`# worker long task 시험 skip: ${skipReason}`);
  if (requireGl && process.env.SKYLENS_WORKER_LONGTASK === '1') throw new Error(`SKYLENS_REQUIRE_GL=1 인데 실행할 수 없음: ${skipReason}`);
}

// 결정적 난수(mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 한 타일(e 64..128, n -128..-64) 안의 완만한 지면 + 잡음 60만 점.
function makeChunk(n) {
  const r = rng(600);
  const pos = new Float32Array(3 * n), nor = new Float32Array(3 * n), col = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    const x = r() * 63, y = r() * 63;
    const z = 20 + 3 * Math.sin(x / 9) * Math.cos(y / 11) + 0.02 * (r() - 0.5);
    const gx = (3 / 9) * Math.cos(x / 9) * Math.cos(y / 11), gy = -(3 / 11) * Math.sin(x / 9) * Math.sin(y / 11);
    const l = Math.hypot(gx, gy, 1);
    pos.set([64 + x, -128 + y, z], 3 * i);
    nor.set([-gx / l, -gy / l, 1 / l], 3 * i);
    const g = 90 + 40 * Math.sin(x / 5) + 30 * Math.cos(y / 7) + (r() - 0.5) * 6;
    col.set([g * 0.8, g, g * 0.6], 3 * i);
  }
  const raw = packChunk({ format: FORMAT_POINT27, segmentId: 7, level: 2, lod: 0, chunkIndex: 0, anchor: { lat: 37.5, lon: 127.0, alt: 30.0 }, fields: { positions: pos, normals: nor, colors: col } });
  return encodeChunk(raw, { lossyColor: false });
}

const MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };
function serve(chunk) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>t</title>'); return; }
    if (url.pathname === '/__chunk.bin') { res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)); return; }
    const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) { res.statusCode = 403; res.end(); return; }
    try {
      const body = await readFile(file);
      res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('T12.5 60만 점 구간 Worker 복호 중 메인 스레드 long task 0(헤드리스 Chromium 실측)', { skip: skipReason ?? false, timeout: 300000 }, async (t) => {
  const chunk = makeChunk(POINTS);
  const server = await serve(chunk);
  t.after(() => { server.close(); return browser.close(); });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  const r = await page.evaluate(async (limitMs) => {
    const { createDecodeWorkerClient } = await import('/client/raster/loop/index.mjs');
    const { toGpuPlanes } = await import('/client/raster/index.mjs');
    const { decodeChunkClient } = await import('/client/codec/index.mjs');
    const bytes = new Uint8Array(await (await fetch('/__chunk.bin')).arrayBuffer());
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    // long task 수집기. 구간마다 새로 만든다(buffered 로 이전 항목이 섞이지 않게 take 로 비운다).
    const tasks = [];
    const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) tasks.push({ start: e.startTime, duration: e.duration }); });
    po.observe({ entryTypes: ['longtask'] });
    const take = async () => { await sleep(100); po.takeRecords().forEach((e) => tasks.push({ start: e.startTime, duration: e.duration })); const o = tasks.splice(0); return o; };

    // 메인 스레드 생존 확인용 틱: 복호 중에도 타이머가 제때 도는지(최대 간격)
    let maxGap = 0; let last = performance.now();
    const ticker = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 5);

    const out = { points: 0, workerMs: 0, toGpuPlanesMs: 0 };
    // 유휴 기준선(계측이 아무것도 안 하는 동안 long task 가 없는지)
    await sleep(300);
    out.idleTasks = (await take()).length;

    // 본 측정: Worker 복호(전송 포함) + 메인에서 하는 toGpuPlanes
    const worker = new Worker('/client/raster/loop/worker.mjs', { type: 'module' });
    const client = createDecodeWorkerClient({ spawn: () => worker, now: () => performance.now() });
    // 첫 요청이 모듈 로드를 기다리는 시간은 복호가 아니므로 작은 요청 하나로 Worker 를 먼저 깨운다는 가정은 쓰지 않는다: 그대로 잰다.
    const copy = bytes.slice(); // 전송(transfer)되므로 사본을 보낸다
    maxGap = 0; last = performance.now();
    const t0 = performance.now();
    const decoded = await client.decode(copy);
    const t1 = performance.now();
    out.decodePhaseTasks = (await take()).map((x) => Math.round(x.duration)); // Worker 복호·전송·응답 배달 구간만
    const gpu = toGpuPlanes(decoded);
    const t2 = performance.now();
    out.workerMs = t1 - t0; out.toGpuPlanesMs = t2 - t1; out.points = gpu.count;
    out.workerPhaseMaxTimerGap = maxGap;
    // 구간 분리: 위 take() 가 100 ms 기다리므로 toGpuPlanes 는 그 뒤에 시작한다(구간이 섞이지 않는다).
    out.toGpuPlanesTasks = (await take()).map((x) => Math.round(x.duration));
    out.workerPathTasks = [...out.decodePhaseTasks, ...out.toGpuPlanesTasks];
    out.clientStats = client.stats();
    client.terminate();

    // 대조: 같은 조각을 메인 스레드에서 동기 복호(기존 기본 decode). 계측이 실제 long task 를 잡는지 확인한다.
    maxGap = 0; last = performance.now();
    await sleep(20);
    const c0 = performance.now();
    const d = decodeChunkClient(bytes.slice());
    toGpuPlanes(d);
    out.controlMs = performance.now() - c0;
    out.controlTasks = (await take()).map((x) => Math.round(x.duration));
    clearInterval(ticker); po.disconnect();
    out.limitMs = limitMs;
    out.supportsLongtask = PerformanceObserver.supportedEntryTypes.includes('longtask');
    return out;
  }, 50);

  assert.deepEqual(errors, [], `페이지 오류: ${errors.join('; ')}`);
  console.log(`# T12.5 측정 points=${r.points} chunkBytes=${chunk.length} workerRoundTripMs=${r.workerMs.toFixed(1)} mainToGpuPlanesMs=${r.toGpuPlanesMs.toFixed(1)}`);
  console.log(`# T12.5 측정 Worker 경로 long task 수=${r.workerPathTasks.length} 길이(ms)=[${r.workerPathTasks}] 유휴 long task=${r.idleTasks} 최대 타이머 간격=${r.workerPhaseMaxTimerGap.toFixed(1)}ms`);
  console.log(`# T12.5 구간별 long task 복호·전송 구간=[${r.decodePhaseTasks}] 메인 toGpuPlanes 구간=[${r.toGpuPlanesTasks}]`);
  console.log(`# T12.5 대조(메인 동기 복호) ms=${r.controlMs.toFixed(1)} long task 수=${r.controlTasks.length} 길이(ms)=[${r.controlTasks}]`);
  assert.equal(r.supportsLongtask, true, 'longtask 관찰자를 지원하지 않는 브라우저');
  assert.equal(r.points, POINTS);
  assert.equal(r.clientStats.responses, 1);
  assert.ok(r.controlTasks.length > 0, '대조(메인 스레드 동기 복호)에서 long task 가 잡히지 않아 계측이 유효하지 않음');
  assert.equal(r.workerPathTasks.length, LONG_TASK_LIMIT, `Worker 복호 경로 long task ${r.workerPathTasks.length} 개(기준 ${LONG_TASK_LIMIT})`);
});
