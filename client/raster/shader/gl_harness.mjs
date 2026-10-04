// T12.2 실제 GL 검증용 헤드리스 Chromium 도구(시험 전용). 기설치 Playwright Chromium(SwiftShader)을 의존성 없이
// 직접 띄워(--dump-dom) index.mjs 의 셰이더를 실제 WebGL2 로 그리고 픽셀을 읽어 온다.
// 페이지는 임시 디렉터리에 만들고 셰이더 모듈은 저장소 파일을 file:// 로 그대로 가져온다(--allow-file-access-from-files).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHADER_URL = new URL('./index.mjs', import.meta.url).href;

/** 실제 GL 시험을 건너뛰지 않고 반드시 돌리라는 환경 변수(SKYLENS_REQUIRE_GL=1). 켜져 있으면 Chromium 이 없을 때 skip 대신 실패한다. */
export function requireGl() {
  return process.env.SKYLENS_REQUIRE_GL === '1';
}

/**
 * node:test 의 skip 옵션 값. REQUIRE_GL 이 꺼져 있으면 reason(없으면 false), 켜져 있으면 항상 false 로 돌려 시험이 실제로 돌다가 실패하게 한다.
 * @param {string|null|undefined} reason 건너뛸 이유(건너뛸 필요가 없으면 비움)
 */
export function glSkip(reason) {
  if (!reason) return false;
  return requireGl() ? false : reason;
}

/** 쓸 수 있는 Chromium 실행 파일 경로. 환경 변수 SKYLENS_CHROMIUM 이 먼저이고(틀린 경로면 오류), 없으면 Playwright 설치 위치를 찾는다. 없으면 null. */
export function findChromium() {
  const env = process.env.SKYLENS_CHROMIUM;
  if (env) {
    if (!existsSync(env)) throw new Error(`SKYLENS_CHROMIUM 경로가 없음: ${env}`);
    return env;
  }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', join(homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    let names;
    try {
      names = readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const name of names) {
      const cands = name.startsWith('chromium_headless_shell')
        ? [join(root, name, 'chrome-linux', 'headless_shell'), join(root, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell')]
        : name.startsWith('chromium-') ? [join(root, name, 'chrome-linux', 'chrome')] : [];
      for (const c of cands) if (existsSync(c)) return c;
    }
  }
  return null;
}

const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');

const PAGE_SCRIPT = `
import { createPointProgram, applyPointUniforms, ATTRIB } from ${JSON.stringify(SHADER_URL)};
import { DATA } from './data.mjs';
const out = document.getElementById('out');
const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const result = { views: [] };
try {
  const pos = new Float32Array(dec(DATA.positions).buffer);
  const col = dec(DATA.colors);
  const oct = new Int8Array(dec(DATA.normalOct).buffer);
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: false, depth: true, alpha: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
  if (!gl) throw new Error('webgl2 없음');
  result.renderer = gl.getParameter(gl.RENDERER) + ' / ' + gl.getParameter(gl.VERSION);
  const { program, uniforms } = createPointProgram(gl);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = (data, loc, size, type) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, false, 0, 0);
  };
  buf(pos, ATTRIB.position, 3, gl.FLOAT);
  buf(col, ATTRIB.color, 3, gl.UNSIGNED_BYTE);
  buf(oct, ATTRIB.normalOct, 2, gl.BYTE);
  const maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
  result.maxPointSize = maxPointSize;
  for (const U of DATA.views) {
    canvas.width = U.u_bw;
    canvas.height = U.u_bh;
    result.depthBits = gl.getParameter(gl.DEPTH_BITS);
    gl.viewport(0, 0, U.u_bw, U.u_bh);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.useProgram(program);
    applyPointUniforms(gl, uniforms, { ...U, u_maxPointSize: maxPointSize });
    gl.drawArrays(gl.POINTS, 0, pos.length / 3);
    const px = new Uint8Array(4 * U.u_bw * U.u_bh);
    gl.readPixels(0, 0, U.u_bw, U.u_bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // 아래에서 위 행 RGBA → 위에서 아래 행 RGB
    const rgb = new Uint8Array(3 * U.u_bw * U.u_bh);
    for (let g = 0; g < U.u_bh; g++) {
      const j = U.u_bh - 1 - g;
      for (let i = 0; i < U.u_bw; i++) for (let c = 0; c < 3; c++) rgb[3 * (j * U.u_bw + i) + c] = px[4 * (g * U.u_bw + i) + c];
    }
    result.views.push(enc(rgb));
  }
  result.glError = gl.getError();
} catch (e) {
  result.error = String(e && e.message || e);
}
out.textContent = JSON.stringify(result);
`;

/**
 * 셰이더를 실제 WebGL2 로 그린다.
 * @param {string} chrome findChromium 결과
 * @param {Array<Record<string, any>>} views pointUniformValues 결과 배열(u_maxPointSize 는 페이지가 실제 한도로 바꾼다)
 * @param {{positions: Float32Array, colors: Uint8Array, normalOct: Int8Array}} pts
 * @returns {{renderer: string, maxPointSize: number, depthBits: number, glError: number, views: Uint8Array[]}}
 */
export function renderInChromium(chrome, views, pts) {
  const dir = mkdtempSync(join(tmpdir(), 'skylens-shader-'));
  try {
    const data = { positions: b64(pts.positions), colors: b64(pts.colors), normalOct: b64(pts.normalOct), views };
    writeFileSync(join(dir, 'data.mjs'), `export const DATA = ${JSON.stringify(data)};\n`);
    writeFileSync(join(dir, 'page.html'), `<!doctype html><html><body><pre id="out"></pre><script type="module">${PAGE_SCRIPT}</script></body></html>`);
    const r = spawnSync(chrome, [
      '--headless', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--allow-file-access-from-files', `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', pathToFileURL(join(dir, 'page.html')).href,
    ], { encoding: 'utf8', maxBuffer: 1 << 30, timeout: 300000 });
    const m = /<pre id="out">([^<]*)<\/pre>/.exec(r.stdout || '');
    if (!m || !m[1]) throw new Error(`chromium 결과 없음(status ${r.status}): ${(r.stderr || '').slice(-2000)}`);
    const res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    if (res.error) throw new Error(`페이지 오류: ${res.error}`);
    res.views = res.views.map((s) => new Uint8Array(Buffer.from(s, 'base64')));
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
