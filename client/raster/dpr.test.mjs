// F-243 ② createRenderer 의 devicePixelRatio ≠ 1 시험. setView 의 K 는 CSS 픽셀이고 셰이더 유니폼 u_fx·u_fy·u_cx·u_cy 는
// 장치 픽셀(scaleIntrinsics: sx = round(W·dpr)/W, sy = round(H·dpr)/H), u_bw·u_bh·캔버스·viewport 는 round(W·dpr)×round(H·dpr)
// 이어야 한다. 기대값은 계약 문구의 식으로 시험 안에서 따로 계산한다(구현 함수를 다시 부르지 않는다).
// 가짜 gl 로 유니폼 기록을 보고, 헤드리스 Chromium(SwiftShader)이 있으면 실제 WebGL2 로 그려 점이 놓인 장치 픽셀까지 본다.
// 벽시계 단언은 하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRenderer } from './index.mjs';
import { findChromium, glSkip } from './shader/gl_harness.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

// ---- 가짜 gl·캔버스(유니폼·viewport 기록) ----
function fakeCanvas() {
  const calls = [];
  const base = {
    calls,
    createBuffer: () => ({}),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createShader: () => ({}),
    createProgram: () => ({}),
    createVertexArray: () => ({}),
    getUniformLocation: (_p, name) => ({ name }),
    getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1024] : 0),
    isContextLost: () => false,
  };
  const gl = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
      return (...args) => { calls.push([p, ...args]); };
    },
  });
  const canvas = {
    width: 300, height: 150,
    getContext: (kind) => (kind === 'webgl2' ? gl : null),
    addEventListener() {},
    removeEventListener() {},
  };
  return { canvas, calls };
}

/** 마지막 draw 에서 uniform1f 로 올린 값(이름 → 값) */
function lastUniforms(calls) {
  const out = {};
  for (const c of calls) if (c[0] === 'uniform1f' && c[1] && c[1].name) out[c[1].name] = c[2];
  return out;
}

const K_CSS = { fx: 20, fy: 20, cx: 16.5, cy: 12.5 };
// 점이 모두 타일 (0, 0) 안의 양수 좌표에 놓이도록 카메라를 (10, 10) 위에 둔다
const T = [-10, -10, 0];
const baseView = (width, height, dpr) => ({
  R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: T, K: K_CSS, width, height, devicePixelRatio: dpr,
});

// 계약 식으로 따로 계산한 장치 픽셀 기대값
function expectedDevice(width, height, dpr) {
  const bw = Math.round(width * dpr);
  const bh = Math.round(height * dpr);
  const sx = bw / width;
  const sy = bh / height;
  return { bw, bh, sx, sy, fx: K_CSS.fx * sx, fy: K_CSS.fy * sy, cx: K_CSS.cx * sx, cy: K_CSS.cy * sy };
}

// (W, H, dpr): 정수 dpr 2·3, 버퍼가 정수가 되는 비정수 1.5, 버퍼 반올림이 생기는 33×25@1.5(49.5 → 50, 37.5 → 38), 기준 1
const CASES = [[32, 24, 1], [32, 24, 2], [32, 24, 3], [32, 24, 1.5], [33, 25, 1.5]];

test('dpr ≠ 1: 셰이더 유니폼 u_fx·u_fy·u_cx·u_cy 는 장치 픽셀 K, u_bw·u_bh·캔버스·viewport 는 장치 픽셀 버퍼', () => {
  for (const [w, h, dpr] of CASES) {
    const { canvas, calls } = fakeCanvas();
    const r = createRenderer({ canvas, maxPieceBytes: 1 << 16, maxResidentBytes: 1 << 20 });
    r.setView(baseView(w, h, dpr));
    calls.length = 0;
    r.draw();
    const e = expectedDevice(w, h, dpr);
    const u = lastUniforms(calls);
    const tag = `${w}×${h}@${dpr}`;
    assert.deepEqual([u.u_bw, u.u_bh], [e.bw, e.bh], `${tag} u_bw·u_bh`);
    assert.deepEqual([canvas.width, canvas.height], [e.bw, e.bh], `${tag} 캔버스 크기`);
    assert.deepEqual(calls.find((c) => c[0] === 'viewport'), ['viewport', 0, 0, e.bw, e.bh], `${tag} viewport`);
    for (const k of ['fx', 'fy', 'cx', 'cy']) {
      assert.ok(Math.abs(u[`u_${k}`] - e[k]) <= 1e-9 * Math.abs(e[k]), `${tag} u_${k} = ${u[`u_${k}`]}, 기대 ${e[k]}`);
    }
    // 정수 dpr 이면 장치 K 는 CSS K 의 정확히 dpr 배다
    if (Number.isInteger(dpr)) assert.deepEqual([u.u_fx, u.u_fy, u.u_cx, u.u_cy], [20 * dpr, 20 * dpr, 16.5 * dpr, 12.5 * dpr], tag);
    r.dispose();
  }
});

test('dpr ≠ 1: 같은 CSS 뷰에서 dpr 만 바꿔 setView 하면 유니폼이 그 dpr 로 다시 계산된다', () => {
  const { canvas, calls } = fakeCanvas();
  const r = createRenderer({ canvas, maxPieceBytes: 1 << 16, maxResidentBytes: 1 << 20 });
  for (const dpr of [3, 1, 2, 1.5]) {
    r.setView(baseView(32, 24, dpr));
    calls.length = 0;
    r.draw();
    const u = lastUniforms(calls);
    const e = expectedDevice(32, 24, dpr);
    assert.deepEqual([u.u_fx, u.u_cx, u.u_cy, u.u_bw, u.u_bh], [e.fx, e.cx, e.cy, e.bw, e.bh], `dpr ${dpr}`);
  }
  r.dispose();
});

// ---- 실제 WebGL2(헤드리스 Chromium + SwiftShader): 점이 놓이는 장치 픽셀 ----
const CHROME = findChromium();
const SKIP_REASON = 'Chromium 없음(SKYLENS_CHROMIUM 이 비었거나 틀린 경로, Playwright 설치 위치에도 없음): 실제 GL 픽셀 위치 시험을 건너뜀';
if (!CHROME) console.log(`dpr.test: ${SKIP_REASON}`);
const RENDERER_URL = new URL('./index.mjs', import.meta.url).href;
const ANCHOR = { lat: 37.5, lon: 127, alt: 30 };
const KEY = '3.1.0.0.0.0';
const COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [200, 100, 50]];

/**
 * 장치 픽셀 칸 (i, j) 의 중심에 투영되는 세계 점. R = I, t = (−10, −10, 0), 깊이 5 m:
 * 장치 u = sx·(fx·(e − 10)/5 + cx) 이므로 e = 10 + 5·((i + 0.5)/sx − cx)/fx (n 도 같은 식, sy·cy).
 */
function worldAtDevicePixel(e, i, j) {
  const uCss = (i + 0.5) / e.sx;
  const vCss = (j + 0.5) / e.sy;
  return [-T[0] + (5 * (uCss - K_CSS.cx)) / K_CSS.fx, -T[1] + (5 * (vCss - K_CSS.cy)) / K_CSS.fy, 5];
}

test('실제 WebGL2 dpr 2·3·1.5: 점이 장치 픽셀 버퍼의 기대 칸에 그려지고 다른 칸은 검다', { skip: glSkip(CHROME ? null : SKIP_REASON) }, () => {
  assert.ok(CHROME, 'Chromium 없음: SKYLENS_REQUIRE_GL=1 에서는 실제 GL 검증을 건너뛸 수 없다');
  const cases = CASES.filter(([, , dpr]) => dpr !== 1).map(([w, h, dpr]) => {
    const e = expectedDevice(w, h, dpr);
    // 버퍼의 네 사분면에 흩어 둔 칸. CSS K 를 그대로 쓰면 장면이 1/dpr 크기로 왼쪽 위에 몰려 이 칸들을 벗어난다
    const targets = [
      [Math.floor(e.bw * 0.25), Math.floor(e.bh * 0.25)],
      [Math.floor(e.bw * 0.75), Math.floor(e.bh * 0.25)],
      [Math.floor(e.bw * 0.25), Math.floor(e.bh * 0.75)],
      [Math.floor(e.bw * 0.75), Math.floor(e.bh * 0.75)],
    ];
    const positions = targets.flatMap(([i, j]) => worldAtDevicePixel(e, i, j));
    const bytes = packChunk({
      format: FORMAT_POINT27, segmentId: 3, level: 1, lod: 0, chunkIndex: 0, anchor: ANCHOR,
      fields: {
        positions: Float32Array.from(positions),
        colors: Uint8Array.from(COLORS.flat()),
        normals: Float32Array.from(targets.flatMap(() => [0, 0, 1])),
      },
    });
    return { w, h, dpr, e, targets, b64: Buffer.from(bytes).toString('base64') };
  });
  const dir = mkdtempSync(join(tmpdir(), 'skylens-dpr-'));
  try {
    const page = `
import { createRenderer } from ${JSON.stringify(RENDERER_URL)};
const CASES = ${JSON.stringify(cases.map((c) => ({ w: c.w, h: c.h, dpr: c.dpr, b64: c.b64 })))};
const out = document.getElementById('out');
const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const res = { cases: [] };
try {
  for (const C of CASES) {
    const canvas = document.createElement('canvas');
    const r = createRenderer({ canvas, maxPieceBytes: 1 << 16, maxResidentBytes: 1 << 20,
      shading: { lightDirWorld: [0, 0, 1], pointSizeM: 0.05, near: 0.1, far: 100 }, contextAttributes: { preserveDrawingBuffer: true } });
    await r.uploadPiece(${JSON.stringify(KEY)}, dec(C.b64));
    r.setArrived([{ segmentId: 3, level: 1, keys: [${JSON.stringify(KEY)}] }]);
    r.setView({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: ${JSON.stringify(T)}, K: ${JSON.stringify(K_CSS)}, width: C.w, height: C.h, devicePixelRatio: C.dpr });
    const stats = r.draw();
    const gl = canvas.getContext('webgl2');
    const w = canvas.width, h = canvas.height;
    const px = new Uint8Array(4 * w * h);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const rgb = [];
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const o = 4 * ((h - 1 - j) * w + i); rgb.push(px[o], px[o + 1], px[o + 2]); }
    res.cases.push({ w, h, drawnPoints: stats.drawnPoints, rgb, glError: gl.getError() });
    r.dispose();
  }
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
    assert.equal(res.cases.length, cases.length);
    cases.forEach((c, n) => {
      const got = res.cases[n];
      const tag = `${c.w}×${c.h}@${c.dpr}`;
      assert.equal(got.glError, 0, tag);
      assert.equal(got.drawnPoints, 4, tag);
      assert.deepEqual([got.w, got.h], [c.e.bw, c.e.bh], `${tag} 그리기 버퍼`);
      const at = (i, j) => got.rgb.slice(3 * (j * got.w + i), 3 * (j * got.w + i) + 3);
      c.targets.forEach(([i, j], q) => assert.deepEqual(at(i, j), COLORS[q], `${tag} 장치 픽셀 (${i}, ${j})`));
      // 칠해진 칸은 정확히 그 4개
      let lit = 0;
      for (let p = 0; p < got.w * got.h; p += 1) if (got.rgb[3 * p] | got.rgb[3 * p + 1] | got.rgb[3 * p + 2]) lit += 1;
      assert.equal(lit, 4, `${tag} 칠해진 칸 수`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
