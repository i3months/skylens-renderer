// T12.5 '60만 점 구간 복호 중 메인 스레드 long task 0' 실측(헤드리스 Chromium). 기본 npm test 에 들어 있다.
// 단언은 long task 개수(벽시계 시간 단언 아님)다. Chromium·playwright 가 없으면 이유를 출력하고 skip 하며,
// SKYLENS_REQUIRE_GL=1 이면 skip 대신 실패한다(glSkip 규칙). Chromium 은 SKYLENS_CHROMIUM 또는 기설치 Playwright Chromium 을 쓴다.
// 방법: 60만 점 codec 1 조각을 만들어 로컬 http 로 내려주고, 페이지에서 실제 createRenderer(webgl2 canvas,
// decode = 복호 Worker 의 client.decode)를 만들어 uploadPiece → setArrived·setView → 첫 draw 까지 걸리는 동안
// PerformanceObserver longtask 를 센다. count·origin·길이 검사는 페이지가 흉내 내지 않고 렌더러(uploadPiece)가 한다.
// 기준은 0 이다(낮추지 않는다). 헤드리스 Chromium 은 SwiftShader(소프트웨어 GL)로 그리므로 GPU 시간은 실제 장치와 다르다.
// 그래서 시간 값은 출력만 하고 단언하지 않으며, long task 개수만 단언한다.
// 측정이 유효한지 보려고 같은 조각을 메인 스레드에서 동기 복호하는 대조도 재서 long task 가 1 개 이상 잡히는지 단언한다.
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
import { decodeChunkClient } from '../../codec/index.mjs';
import { glSkip, findChromium } from '../shader/gl_harness.mjs';

const POINTS = 600_000;
const LONG_TASK_LIMIT = 0; // 성공 기준(T12.5). 측정에 맞춰 바꾸지 않는다.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
let skipReason = null;

let chromium = null;
let browser = null;
{
  const require = createRequire(import.meta.url);
  for (const p of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { ({ chromium } = require(p)); break; } catch { /* 다음 후보 */ }
  }
  if (!chromium) skipReason = 'playwright 모듈을 찾지 못함';
}
if (!skipReason) {
  const exe = findChromium(); // SKYLENS_CHROMIUM 이 틀린 경로면 여기서 던진다
  try {
    browser = await chromium.launch({ ...(process.env.SKYLENS_CHROMIUM ? { executablePath: exe } : {}), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  } catch (e) { skipReason = `Chromium 실행 실패: ${e.message.split('\n')[0]}`; }
}
if (skipReason) console.log(`# worker long task 시험 skip: ${skipReason}`);

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

test('T12.5 60만 점 조각 uploadPiece→첫 draw 구간 메인 스레드 long task 0(실제 createRenderer, 헤드리스 Chromium 실측)', { skip: glSkip(skipReason), timeout: 300000 }, async (t) => {
  assert.ok(!skipReason, `실제 Chromium 을 쓸 수 없음(SKYLENS_REQUIRE_GL=1): ${skipReason}`);
  const chunk = makeChunk(POINTS);
  const h = decodeChunkClient(chunk.slice()).header;
  const KEY = [h.segmentId, h.level, h.tileX, h.tileY, h.lod, h.chunkIndex].join('.');
  const server = await serve(chunk);
  t.after(() => { server.close(); return browser.close(); });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  const r = await page.evaluate(async ({ key, segmentId, level }) => {
    const { createDecodeWorkerClient } = await import('/client/raster/loop/index.mjs');
    const { createRenderer, toGpuPlanes } = await import('/client/raster/index.mjs');
    const { decodeChunkClient } = await import('/client/codec/index.mjs');
    const bytes = new Uint8Array(await (await fetch('/__chunk.bin')).arrayBuffer());
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    // long task 수집기. take 가 구간마다 비운다(앞 구간 항목이 섞이지 않게 100 ms 기다린 뒤 가져온다).
    const tasks = [];
    const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) tasks.push({ start: e.startTime, duration: e.duration }); });
    po.observe({ entryTypes: ['longtask'] });
    const take = async () => { await sleep(100); po.takeRecords().forEach((e) => tasks.push({ start: e.startTime, duration: e.duration })); return tasks.splice(0); };

    const out = {};
    await sleep(300);
    out.idleTasks = (await take()).length; // 유휴 기준선

    // 본 측정: 실제 렌더러(decode = Worker client.decode)로 uploadPiece 부터 첫 draw 까지
    const worker = new Worker('/client/raster/loop/worker.mjs', { type: 'module' });
    const client = createDecodeWorkerClient({ spawn: () => worker, now: () => performance.now() });
    const canvas = document.createElement('canvas');
    const renderer = createRenderer({ canvas, maxPieceBytes: 1 << 26, maxResidentBytes: 1 << 28, decode: (b) => client.decode(b) });
    out.webgl2 = !!canvas.getContext('webgl2');
    // Worker 생성·createRenderer·getContext·셰이더 컴파일은 t0 전에 일어나므로 버린다
    await take();
    await sleep(100);
    const t0 = performance.now();
    await renderer.uploadPiece(key, bytes.slice()); // 전송(transfer)되므로 사본을 보낸다
    const t1 = performance.now();
    renderer.setArrived([{ segmentId, level, keys: [key] }]);
    renderer.setView({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-96, 96, -40], K: { fx: 400, fy: 400, cx: 320, cy: 240 }, width: 640, height: 480, devicePixelRatio: 1 });
    const stats = renderer.draw();
    const t2 = performance.now();
    out.uploadMs = t1 - t0;
    out.drawMs = t2 - t1;
    out.drawnPoints = stats.drawnPoints;
    out.realPathTasks = (await take()).filter((x) => x.start >= t0).map((x) => Math.round(x.duration));
    out.clientStats = client.stats();
    renderer.dispose();
    client.terminate();

    // 대조: 같은 조각을 메인 스레드에서 동기 복호(기존 기본 decode). 계측이 실제 long task 를 잡는지 확인한다.
    await sleep(20);
    const c0 = performance.now();
    toGpuPlanes(decodeChunkClient(bytes.slice()));
    out.controlMs = performance.now() - c0;
    out.controlTasks = (await take()).map((x) => Math.round(x.duration));
    po.disconnect();
    out.supportsLongtask = PerformanceObserver.supportedEntryTypes.includes('longtask');
    return out;
  }, { key: KEY, segmentId: h.segmentId, level: h.level });

  assert.deepEqual(errors, [], `페이지 오류: ${errors.join('; ')}`);
  console.log(`# T12.5 측정(SwiftShader) chunkBytes=${chunk.length} uploadPiece ms=${r.uploadMs.toFixed(1)} setArrived·setView·draw ms=${r.drawMs.toFixed(1)} drawnPoints=${r.drawnPoints}`);
  console.log(`# T12.5 측정 실제 경로(uploadPiece→첫 draw) long task 수=${r.realPathTasks.length} 길이(ms)=[${r.realPathTasks}] 유휴 long task=${r.idleTasks}`);
  console.log(`# T12.5 대조(메인 동기 복호) ms=${r.controlMs.toFixed(1)} long task 수=${r.controlTasks.length} 길이(ms)=[${r.controlTasks}]`);
  assert.equal(r.supportsLongtask, true, 'longtask 관찰자를 지원하지 않는 브라우저');
  assert.equal(r.webgl2, true, 'webgl2 컨텍스트를 얻지 못함');
  assert.equal(r.drawnPoints, POINTS);
  assert.equal(r.clientStats.responses, 1);
  assert.equal(r.idleTasks, 0, `유휴 구간에 long task ${r.idleTasks} 개: 계측 기준선이 오염됨`);
  assert.ok(r.controlTasks.length > 0, '대조(메인 스레드 동기 복호)에서 long task 가 잡히지 않아 계측이 유효하지 않음');
  assert.equal(r.realPathTasks.length, LONG_TASK_LIMIT, `uploadPiece→첫 draw long task ${r.realPathTasks.length} 개 [${r.realPathTasks}] ms (기준 ${LONG_TASK_LIMIT})`);
});
