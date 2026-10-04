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
// 성공 기준(T12.5). 측정에 맞춰 바꾸지 않는다. 판정 범위(F-255 3차, 결정 0038): t0(uploadPiece 호출) 뒤에 끝나는 long task 마다
// 비-GL 시간 = duration − (그 task 구간과 GL 호출 단위 구간들이 겹친 ms 합) 을 구하고, 비-GL 시간이 LONG_TASK_MS(long task 정의 50 ms)를
// 넘는 task 를 센다. GL 호출 구간은 페이지가 WebGL2RenderingContext.prototype 의 GPU 작업 호출(bufferData·drawArrays·texImage2D·
// compileShader·linkProgram·readPixels·finish·flush 등과 드로잉 버퍼를 다시 할당하는 canvas.width/height 대입)을 감싸 잰 호출별 시작~끝이다(헤드리스 SwiftShader 의 소프트웨어 GL 시간은
// 실제 장치와 달라서 뺀다). 경계 hook(onGlUploadStart~End, onDrawStart~End) 구간 전체는 더 이상 빼지 않는다(그 안의 CPU 작업도 센다). 그 밖(uploadPiece 동기부·복호 응답 처리·검사·makeRoom·setArrived·
// setView·draw 의 선택 계산)은 같은 task 에 GL 이 섞여도 모두 센다. 경계 hook 위치는 client/raster/hook_order.test.mjs 가 고정한다.
// GL 구간을 포함한 전체 구간 long task 0 은 실제 GPU 에서 보는 [local] 하위 작업이다.
const LONG_TASK_LIMIT = 0;
const LONG_TASK_MS = 50; // long task 정의(문턱). 바꾸지 않는다
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

  const r = await page.evaluate(async ({ key, segmentId, level, LONG_TASK_MS }) => {
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
    // 계측은 시각만 찍는다(await·sleep 을 끼우지 않아 측정 경로의 task 구성이 운영과 같다)
    const marks = {};
    const gl = []; // GL 호출 구간 [{kind, s, e}] — 렌더러 testHooks 가 알린다
    // GL 호출 단위 계측: 실제 GPU 작업 호출(WebGL2RenderingContext.prototype)을 감싸 호출마다 [시작, 끝] 을 남긴다.
    // 판정의 차감은 이 호출 구간만이다(경계 hook 구간 전체가 아님): 경계 안의 사건 없는 CPU 작업은 차감되지 않는다.
    const glCalls = [];
    const GL_FNS = ['bufferData', 'bufferSubData', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'createBuffer', 'createTexture', 'createShader', 'createProgram', 'compileShader', 'linkProgram', 'readPixels', 'finish', 'flush', 'clear', 'generateMipmap', 'deleteBuffer', 'deleteTexture'];
    out.wrappedGl = [];
    for (const name of GL_FNS) {
      const orig = WebGL2RenderingContext.prototype[name];
      if (typeof orig !== 'function') continue;
      out.wrappedGl.push(name);
      WebGL2RenderingContext.prototype[name] = function (...a) {
        const s = performance.now();
        try { return orig.apply(this, a); } finally { glCalls.push({ name, s, e: performance.now() }); }
      };
    }
    // canvas.width/height 대입은 드로잉 버퍼(백버퍼)를 다시 할당하는 GPU 작업이다(첫 draw 에서 일어남): 같은 GL 호출로 센다
    for (const prop of ['width', 'height']) {
      const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
      if (!desc || !desc.set) continue;
      out.wrappedGl.push(`canvas.${prop}=`);
      Object.defineProperty(HTMLCanvasElement.prototype, prop, { ...desc, set(v) {
        const s = performance.now();
        try { desc.set.call(this, v); } finally { glCalls.push({ name: `canvas.${prop}=`, s, e: performance.now() }); }
      } });
    }
    const glMsIn = (a, b) => { // [a,b] 와 GL 호출 구간 합집합이 겹친 ms
      const iv = glCalls.map((c) => [Math.max(a, c.s), Math.min(b, c.e)]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
      let sum = 0, cur = -Infinity;
      for (const [x, y] of iv) { const lo = Math.max(x, cur); if (y > lo) { sum += y - lo; cur = y; } }
      return sum;
    };
    const glStart = (kind) => () => gl.push({ kind, s: performance.now(), e: NaN });
    const glEnd = (kind) => () => { const g = gl[gl.length - 1]; if (g && g.kind === kind && Number.isNaN(g.e)) g.e = performance.now(); else gl.push({ kind, s: NaN, e: performance.now() }); };
    const canvas = document.createElement('canvas');
    const renderer = createRenderer({
      canvas, maxPieceBytes: 1 << 26, maxResidentBytes: 1 << 28,
      decode: async (b) => { const p = client.decode(b); marks.called = performance.now(); const d = await p; marks.decoded = performance.now(); out.hadGpu = !!(d && typeof d === 'object' && d.gpu); return d; },
      // toGpuPlanes 는 Worker 응답에 gpu 가 없을 때만 메인에서 불린다: 호출 수를 세어 0 회임을 단언한다
      testHooks: { toGpuPlanes: (...a) => { out.mainToGpuPlanes = (out.mainToGpuPlanes ?? 0) + 1; return toGpuPlanes(...a); }, onGlUploadStart: glStart('glUpload'), onGlUploadEnd: glEnd('glUpload'), onDrawStart: glStart('draw'), onDrawEnd: glEnd('draw') },
    });
    out.webgl2 = !!canvas.getContext('webgl2');
    // Worker 생성·createRenderer·getContext·셰이더 컴파일은 t0 전에 일어나므로 버린다
    await take();
    await sleep(100);
    const t0 = performance.now();
    await renderer.uploadPiece(key, bytes.slice()); // 전송(transfer)되므로 사본을 보낸다
    const t1 = performance.now();
    renderer.setArrived([{ segmentId, level, keys: [key] }]);
    const tA = performance.now();
    renderer.setView({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-96, 96, -40], K: { fx: 400, fy: 400, cx: 320, cy: 240 }, width: 640, height: 480, devicePixelRatio: 1 });
    const stats = renderer.draw();
    const t2 = performance.now();
    const up = gl.filter((g) => g.kind === 'glUpload'), dr = gl.filter((g) => g.kind === 'draw');
    out.glCallCount = glCalls.length;
    out.glSpans = gl.map((g) => ({ kind: g.kind, s: g.s - t0, e: g.e - t0 }));
    out.marksOk = up.length === 1 && dr.length === 1 && gl.every((g) => Number.isFinite(g.s) && Number.isFinite(g.e) && g.s <= g.e)
      && glCalls.some((c) => c.s >= t0 && c.name === 'bufferData') && glCalls.some((c) => c.s >= t0 && c.name === 'drawArrays') // t0 이후 기록만(t0 앞 셰이더 호출로는 참이 되지 않게)
      && Number.isFinite(marks.called) && Number.isFinite(marks.decoded);
    out.uploadMs = t1 - t0;
    out.drawMs = t2 - t1;
    out.drawnPoints = stats.drawnPoints;
    const pathTasks = (await take()).filter((x) => x.start + x.duration > t0);
    if (out.marksOk) {
      const [u] = up, [d] = dr;
      out.stageEdges = { t0, called: marks.called, decoded: marks.decoded, glUploadStart: u.s, glUploadEnd: u.e, t1, tA, drawStart: d.s, drawEnd: d.e, t2 };
      // 단계(시각 구간): long task 가 걸친 단계마다 겹친 ms 를 남겨 판단 근거로 쓴다(판정은 nonGl 만 본다)
      const stages = [
        ['before', -Infinity, t0], ['sync', t0, marks.called], ['response', marks.called, u.s], ['glUpload', u.s, u.e], ['afterUpload', u.e, t1],
        ['setArrived', t1, tA], ['setView', tA, d.s], ['draw', d.s, d.e], ['afterDraw', d.e, t2], ['after', t2, Infinity],
      ];
      out.realPathTasks = pathTasks.map((x) => {
        const a = x.start, b = x.start + x.duration;
        const by = {};
        for (const [name, s, e] of stages) { const ov = Math.min(b, e) - Math.max(a, s); if (ov > 0) by[name] = Math.round(ov * 10) / 10; }
        // 판정값: 비-GL 시간 = duration − (task 구간과 GL 호출 단위 구간들의 겹친 ms 합)
        const glMs = glMsIn(a, b);
        const nonGl = x.duration - glMs;
        return { ms: Math.round(x.duration), startRel: Math.round(a - t0), stages: by, glMs: Math.round(glMs * 10) / 10, nonGl: Math.round(nonGl * 10) / 10, counted: nonGl > LONG_TASK_MS };
      });
    } else {
      out.realPathTasks = pathTasks.map((x) => ({ ms: Math.round(x.duration), startRel: Math.round(x.start - t0), stages: null, glMs: 0, nonGl: x.duration, counted: x.duration > LONG_TASK_MS }));
    }
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
  }, { key: KEY, segmentId: h.segmentId, level: h.level, LONG_TASK_MS });

  assert.deepEqual(errors, [], `페이지 오류: ${errors.join('; ')}`);
  // GL 구간 표시가 없거나 짝이 안 맞으면 제외 판정을 할 수 없으므로 곧바로 실패한다
  assert.equal(r.marksOk, true, `GL 구간 표시(testHooks)가 비었거나 짝이 안 맞음: ${JSON.stringify(r.glSpans)}`);
  console.log(`# T12.5 측정(SwiftShader) chunkBytes=${chunk.length} uploadPiece ms=${r.uploadMs.toFixed(1)} setArrived·setView·draw ms=${r.drawMs.toFixed(1)} drawnPoints=${r.drawnPoints}`);
  console.log(`# T12.5 측정 실제 경로(uploadPiece→첫 draw) long task 수=${r.realPathTasks.length} 길이(ms)=[${r.realPathTasks.map((x) => x.ms)}] 단계=${JSON.stringify(r.realPathTasks)} 단계경계(ms,t0 기준)=${JSON.stringify(Object.fromEntries(Object.entries(r.stageEdges).map(([k, v]) => [k, Math.round((v - r.stageEdges.t0) * 10) / 10])))} 유휴 long task=${r.idleTasks}`);
  console.log(`# T12.5 GL 호출 단위 계측 감싼 함수=${r.wrappedGl.length} 기록 호출 수=${r.glCallCount}`);
  console.log(`# T12.5 대조(메인 동기 복호) ms=${r.controlMs.toFixed(1)} long task 수=${r.controlTasks.length} 길이(ms)=[${r.controlTasks}]`);
  assert.equal(r.supportsLongtask, true, 'longtask 관찰자를 지원하지 않는 브라우저');
  assert.equal(r.webgl2, true, 'webgl2 컨텍스트를 얻지 못함');
  assert.equal(r.drawnPoints, POINTS);
  assert.equal(r.clientStats.responses, 1);
  // Worker 응답에 gpu 가 있었고 메인 toGpuPlanes 는 한 번도 돌지 않았다(Worker 가 gpu 를 빼면 여기서 실패)
  assert.equal(r.hadGpu, true, 'Worker 응답(복호 결과)에 gpu 가 없음');
  assert.equal(r.mainToGpuPlanes ?? 0, 0, `메인 스레드 toGpuPlanes 호출 ${r.mainToGpuPlanes} 회(기대 0)`);
  assert.equal(r.idleTasks, 0, `유휴 구간에 long task ${r.idleTasks} 개: 계측 기준선이 오염됨`);
  assert.ok(r.controlTasks.length > 0, '대조(메인 스레드 동기 복호)에서 long task 가 잡히지 않아 계측이 유효하지 않음');
  // task 마다 GL 호출 구간과 겹친 ms 를 빼고 남은 비-GL 시간이 50 ms 를 넘는 것을 센다(LONG_TASK_LIMIT 주석)
  const counted = r.realPathTasks.filter((x) => x.counted);
  assert.equal(counted.length, LONG_TASK_LIMIT, `uploadPiece→첫 draw 구간 비-GL 시간 ${LONG_TASK_MS} ms 초과 long task ${counted.length} 개 ${JSON.stringify(counted)} (전체[ms·glMs·nonGl·단계별 ms] ${JSON.stringify(r.realPathTasks)}; GL 구간 ${JSON.stringify(r.glSpans)}; 기준 ${LONG_TASK_LIMIT})`);
});
