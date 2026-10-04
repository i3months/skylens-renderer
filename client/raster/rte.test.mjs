// F-243 ③ 앵커에서 먼 장면의 f32 정밀도: 조각 원점 기준 상대 좌표(RTE) 시험.
// 정점 셰이더의 투영을 emulate.mjs 의 단계별 Math.fround 모사로 계산해 f64 정답(CSS 픽셀)과 비교한다.
//   RTE: 위치 = X_w − o(f32), u_tgl = R_gl·o + t_gl(f64 계산 뒤 f32) → 오프셋 5 km·깊이 1–5 m 에서 ≤ 0.5 CSS px.
//   절대 좌표(예전 방식, o = 0): 같은 장면에서 0.5 CSS px 를 넘는다(변이 증거).
// 렌더러 배선은 가짜 gl 로 bufferData 위치·조각별 u_tgl 을 기록해 같은 모사에 넣어 확인한다. 벽시계 단언 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, toGpuPlanes } from './index.mjs';
import { buildCameraUniforms, pieceTranslation } from './camera/index.mjs';
import { pointUniformValues, pieceTglValue, applyPieceOrigin } from './shader/index.mjs';
import { emulateProjectVertex, emulatePointRender } from './shader/emulate.mjs';
import { decodeChunkClient } from '../codec/index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { ClientRasterError, FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

const TOL_CSS_PX = 0.5;
const STEP = 2 ** -10; // quantExp 10(약 1 mm) 양자화 격자
const SHADING = { lightDirWorld: [0, 0, 1], pointSizeM: 0.01, ambient: 0.3, near: 0.1, far: 10000, maxPointSize: 1023 };
// 1920×1080@1.5 를 포함한 화면(CSS 크기, dpr)과 CSS K
const SCREENS = [
  { W: 1920, H: 1080, dpr: 1.5, K: { fx: 1400, fy: 1400, cx: 960, cy: 540 } },
  { W: 1920, H: 1080, dpr: 1, K: { fx: 1400, fy: 1400, cx: 960, cy: 540 } },
  { W: 375, H: 667, dpr: 3, K: { fx: 330, fy: 330, cx: 187.5, cy: 333.5 } },
];
const DEPTHS = [1, 1.5, 2, 3, 4, 5];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** OpenCV 카메라(x 오른쪽, y 아래, z 앞): 방위 yaw(북에서 동쪽으로), 앙각 pitch. R 행 = [오른쪽; 아래; 앞]. */
function camera(C, yaw, pitch) {
  const fwd = [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
  const right = norm(cross(fwd, [0, 0, 1]));
  const down = cross(fwd, right);
  const R = [...right, ...down, ...fwd];
  const t = [0, 1, 2].map((i) => -(R[3 * i] * C[0] + R[3 * i + 1] * C[1] + R[3 * i + 2] * C[2]));
  return { R, t };
}

/** 화면 안 격자 × 깊이로 세계 점을 만들고 quantExp 10 격자에 맞춘다. 원점 o = 점들의 최솟값(조각 bboxMin 과 같은 뜻). */
function scenePoints(cam, scr, C) {
  const Rt = (v) => [0, 1, 2].map((j) => cam.R[j] * v[0] + cam.R[3 + j] * v[1] + cam.R[6 + j] * v[2]);
  const raw = [];
  for (const z of DEPTHS) {
    for (const fu of [0.02, 0.25, 0.5, 0.75, 0.98]) {
      for (const fv of [0.02, 0.33, 0.5, 0.67, 0.98]) {
        const xc = [((fu * scr.W) - scr.K.cx) / scr.K.fx * z, ((fv * scr.H) - scr.K.cy) / scr.K.fy * z, z];
        const d = Rt(xc);
        raw.push([C[0] + d[0], C[1] + d[1], C[2] + d[2]]);
      }
    }
  }
  const o = [0, 1, 2].map((a) => Math.min(...raw.map((p) => p[a])));
  // 원점 기준 정수 격자로 맞춘 f64 세계 점(정답)과 상대 좌표(f32 로 정확)
  const rel = raw.map((p) => sub(p, o).map((x) => Math.round(x / STEP) * STEP));
  const world = rel.map((r) => [o[0] + r[0], o[1] + r[1], o[2] + r[2]]);
  return { o, rel, world };
}

/** f64 정답 CSS 위치. */
function truthCss(cam, K, X) {
  const xc = [0, 1, 2].map((i) => cam.R[3 * i] * X[0] + cam.R[3 * i + 1] * X[1] + cam.R[3 * i + 2] * X[2] + cam.t[i]);
  return [K.fx * xc[0] / xc[2] + K.cx, K.fy * xc[1] / xc[2] + K.cy];
}

/** 렌더러 makeView 와 같은 경로로 유니폼 값을 만든다. */
function uniformsFor(cam, scr) {
  const U = buildCameraUniforms({ R: cam.R, t: cam.t, K: scr.K, width: scr.W, height: scr.H, devicePixelRatio: scr.dpr });
  return pointUniformValues({
    R: cam.R, t: cam.t, K: { fx: U.fx, fy: U.fy, cx: U.cx, cy: U.cy }, bw: U.bw, bh: U.bh, ...SHADING,
  });
}

/** 모사 NDC → CSS 픽셀(f64). */
const ndcToCss = (p, scr) => [(p.xn + 1) / 2 * scr.W, (1 - p.yn) / 2 * scr.H];

/** 오프셋 dist(m) 의 여러 방향·카메라 방위에서 최대 CSS 오차. mode 'rte' | 'absolute'. */
function worstError(scr, dist, mode, order) {
  let worst = 0;
  let n = 0;
  for (let k = 0; k < 8; k += 1) {
    const th = (k / 8) * 2 * Math.PI + 0.3;
    const up = k % 2 ? 30 : 120;
    const C = [dist * Math.cos(th), dist * Math.sin(th), up];
    for (const [yaw, pitch] of [[0.4 + k, -0.2], [2.1 + k, 0.1], [-1.3 + k, -0.6]]) {
      const cam = camera(C, yaw, pitch);
      const { o, rel, world } = scenePoints(cam, scr, C);
      const U = uniformsFor(cam, scr);
      for (let i = 0; i < world.length; i += 1) {
        const p = mode === 'rte'
          ? emulateProjectVertex(U, Float32Array.from(rel[i]), { origin: o, order })
          : emulateProjectVertex(U, Float32Array.from(world[i]), { order });
        assert.ok(p, '카메라 앞 점이 버려짐');
        const [eu, ev] = ndcToCss(p, scr);
        const [tu, tv] = truthCss(cam, scr.K, world[i]);
        worst = Math.max(worst, Math.abs(eu - tu), Math.abs(ev - tv));
        n += 1;
      }
    }
  }
  return { worst, n };
}

test('RTE: 오프셋 5 km·깊이 1–5 m 에서 단계별 f32 모사 투영 오차 ≤ 0.5 CSS px(1920×1080@1.5 포함, 연산 순서 2종)', (t) => {
  for (const scr of SCREENS) {
    for (const order of ['seq', 'fma']) {
      const { worst, n } = worstError(scr, 5000, 'rte', order);
      t.diagnostic(`${scr.W}×${scr.H}@${scr.dpr} ${order}: RTE 최대 ${worst.toExponential(3)} CSS px (${n} 점)`);
      assert.ok(n >= 1000);
      assert.ok(worst <= TOL_CSS_PX, `${scr.W}×${scr.H}@${scr.dpr} ${order}: ${worst} CSS px`);
    }
  }
});

test('변이 증거: 예전 절대 좌표 방식(o = 0)은 같은 시험(5 km, 1920×1080@1.5)에서 0.5 CSS px 를 넘는다', (t) => {
  const scr = SCREENS[0];
  for (const order of ['seq', 'fma']) {
    const abs = worstError(scr, 5000, 'absolute', order).worst;
    const rte = worstError(scr, 5000, 'rte', order).worst;
    t.diagnostic(`${order}: 절대 ${abs.toFixed(3)} CSS px, RTE ${rte.toExponential(3)} CSS px`);
    assert.ok(abs > TOL_CSS_PX, `절대 좌표가 통과해 버림: ${abs}`);
    assert.ok(rte * 10 < abs, `RTE ${rte} 가 절대 ${abs} 보다 충분히 작지 않음`);
  }
});

test('RTE 여유: 오프셋 20 km 에서도 ≤ 0.5 CSS px, 앵커 근처(10 m)는 두 방식 모두 통과', () => {
  const scr = SCREENS[0];
  assert.ok(worstError(scr, 20000, 'rte', 'seq').worst <= TOL_CSS_PX);
  assert.ok(worstError(scr, 10, 'rte', 'seq').worst <= TOL_CSS_PX);
  assert.ok(worstError(scr, 10, 'absolute', 'seq').worst <= TOL_CSS_PX);
});

test('pieceTranslation: t\' = R·o + t(f64), o = 0 이면 t, 잘못된 원점은 piece 오류', () => {
  const cam = camera([5000, -3000, 40], 0.7, -0.3);
  const o = [4998.123, -3001.5, 38.25];
  const tp = pieceTranslation(cam.R, cam.t, o);
  for (let i = 0; i < 3; i += 1) {
    const want = cam.R[3 * i] * o[0] + cam.R[3 * i + 1] * o[1] + cam.R[3 * i + 2] * o[2] + cam.t[i];
    assert.ok(Math.abs(tp[i] - want) < 1e-9);
  }
  // 카메라 근처 원점이면 t' 는 카메라~원점 거리 크기(수 m)
  assert.ok(Math.hypot(...tp) < 10, `|t'| = ${Math.hypot(...tp)}`);
  assert.deepEqual(pieceTranslation(cam.R, cam.t, [0, 0, 0]), cam.t);
  for (const bad of [undefined, [0, 0], [0, NaN, 0], [0, Infinity, 0], '000']) {
    assert.throws(() => pieceTranslation(cam.R, cam.t, bad), (e) => e instanceof ClientRasterError && e.code === 'piece');
  }
  // GL 규약 값: pieceTglValue = R_gl·o + t_gl = diag(1,−1,−1)·(R·o + t)
  const U = uniformsFor(cam, SCREENS[0]);
  const g = pieceTglValue(U, o);
  assert.ok(Math.abs(g[0] - tp[0]) < 1e-9 && Math.abs(g[1] + tp[1]) < 1e-9 && Math.abs(g[2] + tp[2]) < 1e-9);
  // applyPieceOrigin 은 u_tgl 위치에 uniform3f 로 올린다(위치 없으면 건너뜀)
  const calls = [];
  const gl = { uniform3f: (...a) => calls.push(a) };
  applyPieceOrigin(gl, { u_tgl: 'L' }, U, o);
  applyPieceOrigin(gl, { u_tgl: null }, U, o);
  assert.deepEqual(calls, [['L', ...g]]);
});

test('emulatePointRender: pts.origin(상대 좌표 + 조각 u_tgl)과 절대 좌표가 앵커 근처에서 같은 칸을 그린다', () => {
  const scr = { W: 64, H: 48, dpr: 1, K: { fx: 50, fy: 50, cx: 32, cy: 24 } };
  const C = [3.5, -2, 1.5];
  const cam = camera(C, 0.3, -0.1);
  const { o, rel, world } = scenePoints(cam, scr, C);
  const U = uniformsFor(cam, scr);
  const n = world.length;
  const colors = new Uint8Array(3 * n).fill(200);
  const normalOct = new Int8Array(2 * n);
  const a = emulatePointRender(U, { positions: Float32Array.from(world.flat()), colors, normalOct });
  const b = emulatePointRender(U, { positions: Float32Array.from(rel.flat()), colors, normalOct, origin: o });
  let drawn = 0;
  for (let i = 0; i < a.drawn.length; i += 1) drawn += a.drawn[i];
  assert.ok(drawn > 20);
  assert.deepEqual(b.drawn, a.drawn);
});

// ---- 렌더러 배선(가짜 gl) ----
function fakeCanvas() {
  const log = [];
  let id = 1;
  const base = {
    createBuffer: () => ({ id: id++ }),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createShader: () => ({}),
    createProgram: () => ({}),
    createVertexArray: () => ({}),
    getUniformLocation: (_p, name) => ({ name }),
    getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1023] : 0),
    isContextLost: () => false,
  };
  const gl = new Proxy(base, {
    get(tg, p) {
      if (p in tg) return tg[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
      return (...args) => { log.push([p, ...args]); };
    },
  });
  const canvas = { width: 1, height: 1, getContext: (k) => (k === 'webgl2' ? gl : null), addEventListener() {}, removeEventListener() {} };
  return { canvas, log };
}

const ANCHOR = { lat: 37.5, lon: 127, alt: 30 };

/** 카메라 하나로 조각 하나를 만들어 렌더러에 올리고 그린 뒤, GL 에 들어간 값으로 모사한 최대 CSS 오차와 기록을 돌려준다. */
async function rendererCase(scr, C, yaw, pitch) {
  const cam = camera(C, yaw, pitch);
  const { world } = scenePoints(cam, scr, C);
  const n = world.length;
  const key = `2.1.${Math.floor(Math.min(...world.map((p) => p[0])) / 64)}.${Math.floor(Math.min(...world.map((p) => p[1])) / 64)}.0.0`;
  const [segmentId, level, , , lod, chunkIndex] = key.split('.').map(Number);
  const bytes = packChunk({
    format: FORMAT_POINT27, segmentId, level, lod, chunkIndex, anchor: ANCHOR,
    fields: {
      positions: Float32Array.from(world.flat()),
      colors: new Uint8Array(3 * n).fill(200),
      normals: Float32Array.from(Array.from({ length: n }, () => [0, 0, 1]).flat()),
    },
  });
  // 정답 위치: 복호한 f64 위치 bboxMin + q·2^−quantExp
  const dec = decodeChunkClient(bytes);
  const step = 2 ** -dec.header.quantExp;
  const axes = [dec.planes.pos_e, dec.planes.pos_n, dec.planes.pos_u];
  const truth = Array.from({ length: n }, (_, i) => [0, 1, 2].map((a) => dec.header.bboxMin[a] + axes[a][i] * step));

  const f = fakeCanvas();
  const r = createRenderer({ canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20, shading: SHADING, now: () => 0 });
  await r.uploadPiece(key, bytes);
  // GL 에 실제로 올린 위치 버퍼(평면 중 Float32Array 는 position 하나)
  const posBuf = f.log.find((c) => c[0] === 'bufferData' && c[2] instanceof Float32Array)[2];
  r.setArrived([{ segmentId, level, keys: [key] }]);
  r.setView({ R: cam.R, t: cam.t, K: scr.K, width: scr.W, height: scr.H, devicePixelRatio: scr.dpr });
  f.log.length = 0;
  const drawn = r.draw().drawnPoints;
  r.dispose();
  // 그릴 때 u_tgl(uniform3f)은 전역 값 뒤에 조각마다 한 번 올라온다. 마지막 값이 이 조각의 것이다
  const tglCalls = f.log.filter((c) => c[0] === 'uniform3f' && c[1].name === 'u_tgl');
  const tPiece = tglCalls[tglCalls.length - 1].slice(2);
  const rgl = f.log.find((c) => c[0] === 'uniformMatrix3fv' && c[1].name === 'u_Rgl');
  // GL 에 실제로 들어간 값(모사가 f32 로 반올림)으로 투영
  const U = { ...uniformsFor(cam, scr), u_Rgl: [...rgl[3]], u_tgl: tPiece };
  let worst = 0;
  let maxPos = 0;
  for (let i = 0; i < n; i += 1) {
    const X = posBuf.subarray(3 * i, 3 * i + 3);
    maxPos = Math.max(maxPos, Math.abs(X[0]), Math.abs(X[1]), Math.abs(X[2]));
    const p = emulateProjectVertex(U, X);
    assert.ok(p, '카메라 뒤로 투영됨(조각 u_tgl 이 상대 좌표와 맞지 않음)');
    const [eu, ev] = ndcToCss(p, scr);
    const [tu, tv] = truthCss(cam, scr.K, truth[i]);
    worst = Math.max(worst, Math.abs(eu - tu), Math.abs(ev - tv));
  }
  return { n, drawn, worst, maxPos, tglCount: tglCalls.length, tPiece };
}

test('렌더러: 앵커에서 5 km 넘게 먼 조각을 상대 좌표로 올리고 조각마다 u_tgl 을 올려 ≤ 0.5 CSS px(1920×1080@1.5)', async (t) => {
  const scr = SCREENS[0];
  // 한 타일(64 m) 안에 들도록 카메라를 타일 가운데(64k + 32)에 둔다(|오프셋| ≈ 5.0–5.9 km)
  const centers = [[5024, 3040, 31.6], [-4000, 3040, 95], [4000, -3040, 31.6], [32, -5024, 60]];
  let worst = 0;
  for (const C of centers) {
    for (const [yaw, pitch] of [[0.35, -0.15], [2.0, 0.1], [-1.2, -0.5], [3.0, -0.05]]) {
      const c = await rendererCase(scr, C, yaw, pitch);
      assert.equal(c.drawn, c.n);
      assert.equal(c.tglCount, 2, '전역 + 조각 1개');
      worst = Math.max(worst, c.worst);
      // 상대 좌표는 타일 안 크기, 조각 u_tgl 은 카메라~조각 원점 거리 크기
      assert.ok(c.worst <= TOL_CSS_PX, `C=${C} yaw=${yaw}: ${c.worst} CSS px`);
      assert.ok(c.maxPos <= 64, `올린 위치가 상대 좌표가 아님: ${c.maxPos}`);
      assert.ok(Math.hypot(...c.tPiece) < 20, `조각 u_tgl 이 카메라 근처 크기가 아님: ${c.tPiece}`);
    }
  }
  t.diagnostic(`렌더러 경로 최대 ${worst.toExponential(3)} CSS px`);
});

test('toGpuPlanes: origin = bboxMin 이면 위치는 q·2^−quantExp(정확), 생략하면 절대 좌표, 잘못된 원점은 piece', () => {
  const pts = [5000.25, 3000.5, 30, 5001.75, 3002, 31.5];
  const bytes = packChunk({
    format: FORMAT_POINT27, segmentId: 1, level: 0, lod: 0, chunkIndex: 0, anchor: ANCHOR,
    fields: { positions: Float32Array.from(pts), colors: new Uint8Array(6), normals: Float32Array.from([0, 0, 1, 0, 0, 1]) },
  });
  const dec = decodeChunkClient(bytes);
  const rel = toGpuPlanes(dec, dec.header.bboxMin);
  assert.deepEqual(rel.origin, dec.header.bboxMin);
  assert.deepEqual([...rel.planes.position], [0, 0, 0, 1.5, 1.5, 1.5]);
  const abs = toGpuPlanes(dec);
  assert.deepEqual(abs.origin, [0, 0, 0]);
  assert.deepEqual([...abs.planes.position], pts);
  for (const bad of [[0, 0], [0, NaN, 0], 'x']) {
    assert.throws(() => toGpuPlanes(dec, bad), (e) => e instanceof ClientRasterError && e.code === 'piece');
  }
});
