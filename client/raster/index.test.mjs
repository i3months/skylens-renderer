// T12.I createRenderer 시험. 가짜 gl 로 흐름·중복 해제·메모리 한도·소실/복구·dispose 를 보고,
// 헤드리스 Chromium(SwiftShader)이 있으면 실제 WebGL2 로 작은 .skla 조각을 그려 알려진 픽셀을 정답과 비교한다.
// 벽시계 단언은 하지 않는다(시계는 주입).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRenderer, toGpuPlanes } from './index.mjs';
import { createDecodeWorkerClient, createFrameLoop } from './loop/index.mjs';
import { computeCoverage } from './missing/index.mjs';
import { findChromium, glSkip } from './shader/gl_harness.mjs';
import { decodeChunkClient } from '../codec/index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { ClientRasterError, FORMAT_POINT27, FORMAT_GAUSS56 } from '../../contracts/client_raster/index.mjs';

// ---- 가짜 gl·캔버스 ----
function fakeCanvas() {
  const calls = [];
  const live = new Set();
  let nextId = 1;
  let ctxLost = false;
  const base = {
    calls,
    live, // 살아 있는 버퍼
    createBuffer() { const b = { id: nextId++ }; live.add(b); return b; },
    deleteBuffer(b) { calls.push(['deleteBuffer', b && b.id]); live.delete(b); },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createShader: () => ({}),
    createProgram: () => ({ program: true }),
    createVertexArray: () => ({ vao: true }),
    getUniformLocation: (_p, name) => ({ name }),
    getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1024] : 0),
    isContextLost: () => ctxLost,
    drawArrays(mode, first, count) { calls.push(['drawArrays', mode, first, count]); },
    uniform1i(loc, v) { calls.push(['uniform1i', loc && loc.name, v]); },
  };
  const gl = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p; // 상수는 이름 그대로
      return (...args) => { calls.push([p, ...args]); };
    },
  });
  const listeners = new Map();
  const canvas = {
    width: 300, height: 150,
    getContext: (kind) => (kind === 'webgl2' ? gl : null),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type) {
      if (type === 'webglcontextlost') ctxLost = true;
      if (type === 'webglcontextrestored') ctxLost = false;
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ preventDefault() {} });
    },
    listenerCount: () => [...listeners.values()].reduce((s, x) => s + x.size, 0),
  };
  return { canvas, gl: base };
}

const ANCHOR = { lat: 37.5, lon: 127, alt: 30 };

/** 형식 1 조각. positions 는 세계 ENU m. */
function piece1(key, positions, colors, normals) {
  const [segmentId, level, , , lod, chunkIndex] = key.split('.').map(Number);
  const n = positions.length / 3;
  return packChunk({
    format: FORMAT_POINT27, segmentId, level, lod, chunkIndex, anchor: ANCHOR,
    fields: {
      positions: Float32Array.from(positions),
      colors: Uint8Array.from(colors ?? Array(3 * n).fill(200)),
      normals: Float32Array.from(normals ?? Array.from({ length: n }, () => [0, 0, 1]).flat()),
    },
  });
}

function piece2(key, positions) {
  const [segmentId, level, , , lod, chunkIndex] = key.split('.').map(Number);
  const n = positions.length / 3;
  return packChunk({
    format: FORMAT_GAUSS56, segmentId, level, lod, chunkIndex, anchor: ANCHOR,
    fields: {
      positions: Float32Array.from(positions), fdc: new Float32Array(3 * n), opacity: new Float32Array(n),
      scales: new Float32Array(3 * n).fill(-3), rotations: Float32Array.from(Array.from({ length: n }, () => [1, 0, 0, 0]).flat()),
    },
  });
}

const VIEW = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-1, -1, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 };
const arrivedOf = (key) => { const [s, l] = key.split('.').map(Number); return { segmentId: s, level: l, keys: [key] }; };

function make(extra = {}) {
  const f = fakeCanvas();
  let t = 0;
  const r = createRenderer({ canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20, now: () => (t += 1), ...extra });
  return { r, ...f, calls: f.gl.calls };
}

test('toGpuPlanes: 형식 1 은 위치·색·법선, 형식 2 는 위치·색(법선 없음), 위치는 bboxMin + q·2^−quantExp', () => {
  const g1 = toGpuPlanes(decodeChunkClient(piece1('3.1.0.0.0.0', [0.5, 0.5, 5, 1.5, 1.5, 5], [1, 2, 3, 4, 5, 6])));
  assert.equal(g1.format, FORMAT_POINT27);
  assert.equal(g1.count, 2);
  assert.deepEqual([...g1.planes.position], [0.5, 0.5, 5, 1.5, 1.5, 5]);
  assert.deepEqual([...g1.planes.color], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...g1.planes.normalOct], [0, 0, 0, 0]);
  const g2 = toGpuPlanes(decodeChunkClient(piece2('3.1.0.0.0.1', [0.25, 0.5, 2])));
  assert.equal(g2.format, FORMAT_GAUSS56);
  assert.deepEqual(Object.keys(g2.planes), ['position', 'color']);
  assert.throws(() => toGpuPlanes({ header: { format: 9 }, planes: {} }), (e) => e.code === 'piece');
});

test('흐름: 올리기만 해서는 그리지 않고 setArrived 의 draw 만 그린다, 형식 2 는 셰이딩 끔', async () => {
  const { r, calls } = make();
  const k1 = '3.1.0.0.0.0';
  const k2 = '3.1.0.0.0.1';
  const kp = '3.2.0.0.0.0'; // 더 높은 수준(도착 전): pending
  await r.uploadPiece(k1, piece1(k1, [0.5, 0.5, 5, 1.5, 0.5, 5]));
  await r.uploadPiece(k2, piece2(k2, [1, 1, 5]));
  await r.uploadPiece(kp, piece1(kp, [1, 1, 5]));
  assert.equal(r.memoryBytes(), 2 * 17 + 1 * 15 + 1 * 17);
  r.setView(VIEW);
  let s = r.draw();
  assert.deepEqual([s.drawnPieces, s.drawnPoints], [0, 0]); // 도착 전: 아무것도 그리지 않음
  const sel = r.setArrived([{ segmentId: 3, level: 1, keys: [k1, k2] }]);
  assert.deepEqual(sel, { draw: [k1, k2], pending: [kp], discard: [] });
  calls.length = 0;
  s = r.draw();
  assert.deepEqual([s.drawnPieces, s.drawnPoints, s.droppedFrames, s.drawMs], [2, 3, 0, 1]);
  assert.deepEqual(calls.filter((c) => c[0] === 'drawArrays'), [['drawArrays', 'POINTS', 0, 2], ['drawArrays', 'POINTS', 0, 1]]);
  assert.deepEqual(calls.filter((c) => c[0] === 'uniform1i' && c[1] === 'u_shade').map((c) => c[2]), [1, 1, 0]);
  assert.ok(calls.some((c) => c[0] === 'vertexAttrib2f' && c[1] === 2)); // 형식 2: 법선 상수
  // 더 높은 수준 도착 → 낮은 수준은 discard(호출자가 해제)
  const sel2 = r.setArrived([{ segmentId: 3, level: 1, keys: [k1, k2] }, arrivedOf(kp)]);
  assert.deepEqual(sel2, { draw: [kp], pending: [], discard: [k1, k2] });
  for (const k of sel2.discard) r.releasePiece(k);
  assert.equal(r.memoryBytes(), 17);
  assert.deepEqual(r.draw().drawnPoints, 1);
  r.dispose();
});

test('key·헤더 불일치·손상 바이트·잘못된 key 는 piece 오류이고 상주량을 바꾸지 않는다', async () => {
  const { r } = make();
  const bytes = piece1('3.1.0.0.0.0', [0.5, 0.5, 5]);
  await assert.rejects(r.uploadPiece('3.1.0.0.0.7', bytes), (e) => e instanceof ClientRasterError && e.code === 'piece' && /chunkIndex/.test(e.message));
  await assert.rejects(r.uploadPiece('4.1.0.0.0.0', bytes), (e) => e.code === 'piece');
  const broken = bytes.slice(0, 50);
  await assert.rejects(r.uploadPiece('3.1.0.0.0.0', broken), (e) => e.code === 'piece' && /복호 실패/.test(e.message));
  await assert.rejects(r.uploadPiece('nope', bytes), (e) => e.code === 'piece');
  await assert.rejects(r.uploadPiece('3.1.0.0.0.0', [1, 2]), (e) => e.code === 'piece');
  assert.equal(r.memoryBytes(), 0);
  r.dispose();
});

test('중복 해제: 같은 key 를 여러 번·없는 key·업로드 중 해제를 견디고 늦은 업로드가 해제를 되살리지 않는다', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const { r, gl } = make({ decode: async (b) => { await gate; return decodeChunkClient(b); } });
  const k = '3.1.0.0.0.0';
  const p = r.uploadPiece(k, piece1(k, [0.5, 0.5, 5]));
  r.releasePiece(k); // 업로드 중 해제
  r.releasePiece(k);
  r.releasePiece('9.0.0.0.0.0');
  release();
  await p;
  assert.equal(r.memoryBytes(), 0);
  assert.deepEqual(r.residentKeys(), []);
  // 다시 올리면 올라간다(해제 표시가 새 업로드를 막지 않음)
  const { r: r2, gl: gl2 } = make();
  await r2.uploadPiece(k, piece1(k, [0.5, 0.5, 5]));
  const before = gl2.live.size;
  assert.equal(before, 3);
  r2.releasePiece(k);
  r2.releasePiece(k);
  assert.equal(gl2.live.size, 0);
  assert.equal(r2.memoryBytes(), 0);
  assert.equal(gl.live.size, 0);
  r.dispose();
  r2.dispose();
});

test('메모리 한도: 그리지 않는 조각부터 오래된 순으로 해제하고, 그리는 조각만으로 모자라면 memory 오류', async () => {
  const evicted = [];
  // 점 1개 형식 1 = 17 B. 한도 51 B = 3 조각
  const { r } = make({ maxResidentBytes: 51, maxPieceBytes: 40, onEvict: (keys) => evicted.push(...keys) });
  const ks = ['3.1.0.0.0.0', '3.1.0.0.0.1', '3.2.0.0.0.0', '3.2.0.0.0.1', '3.1.0.0.0.2'];
  await r.uploadPiece(ks[0], piece1(ks[0], [0.5, 0.5, 5]));
  r.setArrived([arrivedOf(ks[0])]); // ks[0] 은 그린다
  await r.uploadPiece(ks[2], piece1(ks[2], [0.5, 0.5, 5])); // pending
  await r.uploadPiece(ks[3], piece1(ks[3], [0.5, 0.5, 5])); // pending
  assert.equal(r.memoryBytes(), 51);
  await r.uploadPiece(ks[1], piece1(ks[1], [0.5, 0.5, 5])); // 넘침 → 가장 오래된 pending(ks[2]) 해제
  assert.deepEqual(evicted, [ks[2]]);
  assert.equal(r.memoryBytes(), 51);
  assert.deepEqual(r.residentKeys(), [ks[0], ks[3], ks[1]]);
  // ks[1] 도 그리게 하면 그리지 않는 것은 ks[3] 하나
  r.setArrived([{ segmentId: 3, level: 1, keys: [ks[0], ks[1]] }]);
  // 2점(34 B) 조각: ks[3](17 B) 를 해제해도 17+17+34 > 51 → 아무것도 해제하지 않고 거부
  await assert.rejects(r.uploadPiece(ks[4], piece1(ks[4], [0.5, 0.5, 5, 1, 1, 5])), (e) => e.code === 'memory');
  assert.deepEqual(r.residentKeys(), [ks[0], ks[3], ks[1]]);
  assert.equal(evicted.length, 1);
  // 한 조각 한도(40 B) 초과는 piece
  await assert.rejects(r.uploadPiece(ks[4], piece1(ks[4], [0.5, 0.5, 5, 1, 1, 5, 2, 2, 5])), (e) => e.code === 'piece');
  assert.equal(r.memoryBytes(), 51);
  r.dispose();
});

test('컨텍스트 소실: GPU 자원을 버리고 그리기를 건너뛰며, 복구 때 다시 올릴 key 를 콜백으로 준다', async () => {
  const { r, canvas, calls } = make();
  const k1 = '3.1.0.0.0.0';
  const k2 = '3.1.0.0.0.1';
  const b1 = piece1(k1, [0.5, 0.5, 5]);
  const b2 = piece1(k2, [1, 1, 5]);
  await r.uploadPiece(k1, b1);
  await r.uploadPiece(k2, b2);
  r.setArrived([{ segmentId: 3, level: 1, keys: [k1, k2] }]);
  r.setView(VIEW);
  const seen = [];
  r.onContextLost(() => seen.push('lost'));
  r.onContextRestored((keys) => seen.push(['restored', keys]));
  r.onContextLost(); // 콜백 없이 불러도 된다
  canvas.fire('webglcontextlost');
  assert.equal(r.memoryBytes(), 0);
  assert.equal(r.isContextLost(), true);
  const s = r.draw();
  assert.deepEqual([s.drawnPieces, s.droppedFrames], [0, 1]);
  await assert.rejects(r.uploadPiece(k1, b1), (e) => e.code === 'context');
  r.releasePiece(k2); // 소실 중 해제 → 복구 목록에서 빠진다
  calls.length = 0;
  canvas.fire('webglcontextrestored');
  assert.deepEqual(seen, ['lost', ['restored', [k1]]]);
  assert.ok(calls.some((c) => c[0] === 'linkProgram')); // 프로그램 재생성
  await r.uploadPiece(k1, b1);
  const s2 = r.draw();
  assert.deepEqual([s2.drawnPieces, s2.drawnPoints, s2.droppedFrames], [1, 1, 1]); // 도착 정보는 유지된다
  r.dispose();
});

test('업로드 중 소실: 늦게 끝난 업로드는 context 오류이고 그 key 는 복구 목록에 든다', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const { r, canvas } = make({ decode: async (b) => { await gate; return decodeChunkClient(b); } });
  const k = '3.1.0.0.0.0';
  const p = r.uploadPiece(k, piece1(k, [0.5, 0.5, 5]));
  let got = null;
  r.onContextRestored((keys) => { got = keys; });
  canvas.fire('webglcontextlost');
  release();
  await assert.rejects(p, (e) => e.code === 'context');
  assert.equal(r.memoryBytes(), 0);
  canvas.fire('webglcontextrestored');
  assert.deepEqual(got, [k]);
  r.dispose();
});

test('dispose: 버퍼·프로그램을 지우고 리스너를 떼며, 뒤 호출은 context 오류(해제·dispose 는 조용히)', async () => {
  const { r, gl, canvas, calls } = make();
  const k = '3.1.0.0.0.0';
  await r.uploadPiece(k, piece1(k, [0.5, 0.5, 5]));
  assert.equal(canvas.listenerCount(), 2);
  r.dispose();
  assert.equal(gl.live.size, 0);
  assert.ok(calls.some((c) => c[0] === 'deleteProgram'));
  assert.ok(calls.some((c) => c[0] === 'deleteVertexArray'));
  assert.equal(canvas.listenerCount(), 0);
  assert.equal(r.memoryBytes(), 0);
  r.dispose();
  r.releasePiece(k);
  assert.throws(() => r.draw(), (e) => e.code === 'context');
  assert.throws(() => r.setView(VIEW), (e) => e.code === 'context');
  await assert.rejects(r.uploadPiece(k, piece1(k, [0.5, 0.5, 5])), (e) => e.code === 'context');
});

test('입력 검사: 한도·shading·view·캔버스', () => {
  const f = fakeCanvas();
  assert.throws(() => createRenderer({ canvas: f.canvas, maxPieceBytes: 0, maxResidentBytes: 10 }), (e) => e.code === 'memory');
  assert.throws(() => createRenderer({ canvas: f.canvas, maxPieceBytes: 1, maxResidentBytes: 10, shading: { pointSizeM: -1 } }), (e) => e.code === 'view');
  assert.throws(() => createRenderer({ canvas: {}, maxPieceBytes: 1, maxResidentBytes: 10 }), (e) => e.code === 'context');
  const { r } = make();
  assert.throws(() => r.setView({ ...VIEW, width: 0 }), (e) => e.code === 'view');
  assert.throws(() => r.setView({ ...VIEW, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] }), (e) => e.code === 'view');
  assert.equal(r.draw().droppedFrames, 1); // view 없음 → 건너뜀
  r.dispose();
});

test('주입 복호: loop createDecodeWorkerClient(가짜 Worker)로 복호하고 프레임 루프가 draw 를 부른다', async () => {
  const worker = {
    postMessage(m) { queueMicrotask(() => this.onmessage({ data: { id: m.id, result: decodeChunkClient(m.bytes) } })); },
  };
  const client = createDecodeWorkerClient({ spawn: () => worker });
  const { r } = make({ decode: (b) => client.decode(b) });
  const k = '3.1.0.0.0.0';
  await r.uploadPiece(k, piece1(k, [0.5, 0.5, 5, 1, 1, 5]));
  r.setArrived([arrivedOf(k)]);
  r.setView(VIEW);
  assert.equal(client.stats().responses, 1);
  const frames = [];
  let cb = null;
  let t = 0;
  const loop = createFrameLoop({ draw: () => frames.push(r.draw()), requestFrame: (f) => { cb = f; }, now: () => (t += 16) });
  loop.start();
  cb();
  loop.stop();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].drawnPoints, 2);
  r.dispose();
});

// ---- 실제 WebGL2(헤드리스 Chromium + SwiftShader) ----
const CHROME = findChromium();
const RENDERER_URL = new URL('./index.mjs', import.meta.url).href;

test('실제 WebGL2: .skla 조각을 올려 그리면 알려진 4픽셀이 정답 색이고 도착 전 조각·빈 칸은 검다', { skip: glSkip(CHROME ? null : 'Chromium 없음') }, () => {
  // 32×24, fx = fy = 20, cx = 16.5, cy = 12.5, R = I, t = (−1, −1, 0): 세계 (e, n, 5) → u = 4(e − 1) + 16.5, v = 4(n − 1) + 12.5
  // 점 지름 0.05 m → 반경 0.1 px 이라 중심 칸 하나만 칠한다. 법선 (0,0,1) 과 빛 (0,0,1) 이라 I = 1, 색 그대로.
  const kDraw = '3.1.0.0.0.0';
  const kPend = '3.2.0.0.0.0';
  const drawBytes = piece1(kDraw, [0.5, 0.5, 5, 1.5, 0.5, 5, 0.5, 1.5, 5, 1.5, 1.5, 5],
    [255, 0, 0, 0, 255, 0, 0, 0, 255, 200, 100, 50]);
  const pendBytes = piece1(kPend, [1, 1, 5], [255, 255, 255]); // (16, 12) 에 갈 점. LEVEL_ARRIVED 가 없어 그리면 안 된다
  const expect = [
    { i: 14, j: 10, rgb: [255, 0, 0] },
    { i: 18, j: 10, rgb: [0, 255, 0] },
    { i: 14, j: 14, rgb: [0, 0, 255] },
    { i: 18, j: 14, rgb: [200, 100, 50] },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'skylens-renderer-'));
  try {
    const b64 = (u8) => Buffer.from(u8).toString('base64');
    const page = `
import { createRenderer } from ${JSON.stringify(RENDERER_URL)};
const out = document.getElementById('out');
const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const res = {};
try {
  const canvas = document.createElement('canvas');
  const r = createRenderer({ canvas, maxPieceBytes: 1 << 16, maxResidentBytes: 1 << 20,
    shading: { lightDirWorld: [0, 0, 1], pointSizeM: 0.05, near: 0.1, far: 100 }, contextAttributes: { preserveDrawingBuffer: true } });
  await r.uploadPiece(${JSON.stringify(kDraw)}, dec(${JSON.stringify(b64(drawBytes))}));
  await r.uploadPiece(${JSON.stringify(kPend)}, dec(${JSON.stringify(b64(pendBytes))}));
  res.sel = r.setArrived([{ segmentId: 3, level: 1, keys: [${JSON.stringify(kDraw)}] }]);
  r.setView(${JSON.stringify(VIEW)});
  res.stats = r.draw();
  res.memory = r.memoryBytes();
  const gl = canvas.getContext('webgl2');
  res.renderer = gl.getParameter(gl.RENDERER);
  const w = canvas.width, h = canvas.height;
  const px = new Uint8Array(4 * w * h);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const rgb = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const o = 4 * ((h - 1 - j) * w + i); rgb.push(px[o], px[o + 1], px[o + 2]); }
  res.w = w; res.h = h; res.rgb = rgb; res.glError = gl.getError();
  r.dispose();
} catch (e) { res.error = String(e && e.stack || e); }
out.textContent = JSON.stringify(res);
`;
    writeFileSync(join(dir, 'page.html'), `<!doctype html><html><body><pre id="out"></pre><script type="module">${page}</script></body></html>`);
    const run = spawnSync(CHROME, [
      '--headless', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--allow-file-access-from-files', `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=10000', '--dump-dom',
      pathToFileURL(join(dir, 'page.html')).href,
    ], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120000 });
    const m = /<pre id="out">([^<]*)<\/pre>/.exec(run.stdout || '');
    assert.ok(m && m[1], `chromium 결과 없음(status ${run.status}): ${(run.stderr || '').slice(-1500)}`);
    const res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    assert.equal(res.error, undefined, res.error);
    assert.deepEqual(res.sel, { draw: [kDraw], pending: [kPend], discard: [] });
    assert.deepEqual([res.stats.drawnPieces, res.stats.drawnPoints, res.stats.droppedFrames], [1, 4, 0]);
    assert.equal(res.memory, 4 * 17 + 17);
    assert.deepEqual([res.w, res.h], [32, 24]);
    assert.equal(res.glError, 0);
    const at = (i, j) => res.rgb.slice(3 * (j * res.w + i), 3 * (j * res.w + i) + 3);
    for (const e of expect) assert.deepEqual(at(e.i, e.j), e.rgb, `픽셀 (${e.i}, ${e.j})`);
    assert.deepEqual(at(16, 12), [0, 0, 0]); // 도착 전 조각 자리: 그리지 않음
    // 칠해진 칸은 정확히 4개(빈 칸은 메우지 않는다)
    const drawn = new Uint8Array(res.w * res.h);
    for (let p = 0; p < drawn.length; p += 1) drawn[p] = (res.rgb[3 * p] | res.rgb[3 * p + 1] | res.rgb[3 * p + 2]) ? 1 : 0;
    assert.equal(computeCoverage({ width: res.w, height: res.h, drawn }).drawn, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F-244 ② 메인 쪽: Worker 가 만든 gpu 평면 ----
function withGpu(k, edit) {
  const d = decodeChunkClient(piece1(k, [0.5, 0.5, 5, 1.5, 0.5, 5.25], [1, 2, 3, 4, 5, 6], [0, 0, 1, 0, 0, 1]));
  const gpu = toGpuPlanes(d, d.header.bboxMin); // Worker 가 하는 일
  const out = { header: d.header, planes: d.planes, gpu };
  if (edit) edit(out);
  return out;
}

test('gpu 가 있으면 toGpuPlanes 를 다시 돌리지 않고 기존 경로와 같은 평면·픽셀로 그린다', async () => {
  const k = '3.1.0.0.0.0';
  const bytes = piece1(k, [0.5, 0.5, 5, 1.5, 0.5, 5.25], [1, 2, 3, 4, 5, 6], [0, 0, 1, 0, 0, 1]);
  const run = async (decode) => {
    let toCalls = 0;
    const { r, calls } = make({ decode, testHooks: { toGpuPlanes: (...a) => { toCalls += 1; return toGpuPlanes(...a); } } });
    r.setView(VIEW);
    calls.length = 0;
    await r.uploadPiece(k, bytes);
    const uploads = calls.filter((c) => c[0] === 'bufferData').map((c) => [c[2] && c[2].constructor.name, c[2] ? [...c[2]] : null]);
    r.setArrived([arrivedOf(k)]);
    calls.length = 0;
    const s = r.draw();
    return { toCalls, s: { ...s, drawMs: 0 }, drawCalls: calls.filter((c) => c[0] === 'drawArrays'), uploads, bytes: r.memoryBytes() };
  };
  const old = await run((b) => decodeChunkClient(b));
  const viaGpu = await run((b) => { const d = decodeChunkClient(b); return { ...d, gpu: toGpuPlanes(d, d.header.bboxMin) }; });
  assert.equal(old.toCalls, 1);
  assert.equal(viaGpu.toCalls, 0, 'gpu 가 있는데 toGpuPlanes 를 다시 돌았다');
  assert.deepEqual(viaGpu.s, old.s);
  assert.deepEqual(viaGpu.drawCalls, old.drawCalls);
  assert.deepEqual(viaGpu.uploads, old.uploads);
  assert.ok(viaGpu.uploads.length >= 3);
  assert.equal(viaGpu.bytes, old.bytes);
});

test('잘못된 gpu 는 piece 오류: count·origin·형식·평면 이름·타입·길이', async () => {
  const k = '3.1.0.0.0.0';
  const bad = {
    'count': (d) => { d.gpu.count = 1; },
    'origin': (d) => { d.gpu.origin = [0, 0, 0]; },
    'origin 길이': (d) => { d.gpu.origin = [0.5, 0.5]; },
    'format': (d) => { d.gpu.format = FORMAT_GAUSS56; },
    '평면 길이': (d) => { d.gpu.planes.position = new Float32Array(3); },
    '평면 타입': (d) => { d.gpu.planes.color = new Uint8ClampedArray(6); },
    '법선 누락': (d) => { delete d.gpu.planes.normalOct; },
    '법선 타입': (d) => { d.gpu.planes.normalOct = new Uint8Array(4); },
    '모르는 평면': (d) => { d.gpu.planes.extra = new Uint8Array(2); },
    'planes 없음': (d) => { d.gpu.planes = null; },
    'gpu null': (d) => { d.gpu = null; },
  };
  for (const [name, edit] of Object.entries(bad)) {
    const { r } = make({ decode: () => withGpu(k, edit) });
    await assert.rejects(r.uploadPiece(k, piece1(k, [0.5, 0.5, 5])), (e) => e instanceof ClientRasterError && e.code === 'piece', name);
    assert.equal(r.memoryBytes(), 0, name);
  }
  // 형식 2 에 법선 평면이 있으면 틀림
  const k2 = '3.1.0.0.0.1';
  const d2 = decodeChunkClient(piece2(k2, [0.25, 0.5, 2]));
  const g2 = toGpuPlanes(d2, d2.header.bboxMin);
  const { r } = make({ decode: () => ({ ...d2, gpu: { ...g2, planes: { ...g2.planes, normalOct: new Int8Array(2) } } }) });
  await assert.rejects(r.uploadPiece(k2, piece2(k2, [0.25, 0.5, 2])), (e) => e.code === 'piece');
  // 올바른 gpu 는 통과한다
  const ok = make({ decode: () => withGpu(k) });
  await ok.r.uploadPiece(k, piece1(k, [0.5, 0.5, 5]));
  assert.deepEqual(ok.r.residentKeys(), [k]);
});

// ---- F-245 ⑤: 복구 중 프로그램 재생성 실패 알림 ----
test('복구 중 프로그램 재생성이 실패하면 onContextRestored 가 빈 key 와 오류를 알리고 업로드는 context 로 거부한다', async () => {
  const { r, gl, canvas } = make();
  const k = '3.1.0.0.0.0';
  await r.uploadPiece(k, piece1(k, [0.5, 0.5, 5]));
  r.setView(VIEW);
  const seen = [];
  r.onContextRestored((keys, err) => { seen.push([keys, err && err.code]); });
  canvas.fire('webglcontextlost');
  gl.getProgramParameter = () => false; // 링크 실패
  canvas.fire('webglcontextrestored');
  assert.deepEqual(seen, [[[], 'context']]);
  assert.deepEqual(r.draw().drawnPieces, 0);
  await assert.rejects(r.uploadPiece(k, piece1(k, [0.5, 0.5, 5])), (e) => e.code === 'context');
  // 다시 복구되면 소실 목록이 남아 있어 알린다
  gl.getProgramParameter = () => true;
  canvas.fire('webglcontextlost');
  canvas.fire('webglcontextrestored');
  assert.deepEqual(seen[1], [[k], undefined]);
  r.dispose();
});
