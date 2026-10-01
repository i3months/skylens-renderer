// 브라우저 측정 공용 도구 (first_frame, heap 공유). 같은 대상(dist 를 http 로 서빙)·같은 chromium 인자·같은 device 라벨을 쓴다.
// playwright 는 package.json 에 추가하지 않고 찾아 쓴다. 고정 경로 기본값은 없고 환경변수와 표준 탐색만 쓴다.
//   SKYLENS_PLAYWRIGHT_DIR  playwright 패키지 디렉터리(선택)
//   SKYLENS_CHROMIUM        chromium 실행파일(선택)
//   PLAYWRIGHT_BROWSERS_PATH playwright 브라우저 캐시 디렉터리(선택)
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize, resolve, sep } from 'node:path';

/** 두 모듈이 같은 값을 쓰는 chromium 인자. 소프트웨어 렌더(swiftshader)로 고정한다. */
export const CHROMIUM_ARGS = ['--headless', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'];
export const DEVICE = 'headless-chromium-swiftshader (software render, reference)';

/** playwright 모듈을 찾는다. 환경변수, 표준 require 탐색(NODE_PATH 포함), npm 전역 루트 순. 없으면 null. */
export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const cands = [];
  if (process.env.SKYLENS_PLAYWRIGHT_DIR) cands.push(process.env.SKYLENS_PLAYWRIGHT_DIR);
  cands.push('playwright');
  try { cands.push(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'playwright')); } catch { /* npm 없음 */ }
  for (const c of cands) {
    try {
      const m = req(c);
      if (m?.chromium) return m;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/** chromium 실행파일. SKYLENS_CHROMIUM, playwright 가 아는 경로, PLAYWRIGHT_BROWSERS_PATH 순. 없으면 null. */
export async function findChromium(pw = loadPlaywright()) {
  const env = process.env.SKYLENS_CHROMIUM;
  if (env) return existsSync(env) ? env : null;
  try {
    const p = pw?.chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* 설치 안 됨 */ }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return null;
  const dirs = await readdir(base).catch(() => []);
  for (const d of dirs.filter((x) => /^chromium(_headless_shell)?-\d+$/.test(x)).sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      if (existsSync(join(base, d, rel))) return join(base, d, rel);
    }
  }
  return null;
}

/** 브라우저를 돌릴 수 없는 사유(없으면 null). 테스트가 skip 사유로 쓴다. */
export async function unavailableReason() {
  const pw = loadPlaywright();
  if (!pw) return 'playwright 모듈을 찾을 수 없음(SKYLENS_PLAYWRIGHT_DIR, NODE_PATH 또는 npm 전역 설치 필요)';
  if (!(await findChromium(pw))) return 'chromium 실행파일을 찾을 수 없음(SKYLENS_CHROMIUM 또는 PLAYWRIGHT_BROWSERS_PATH 필요)';
  return null;
}

/** 공용 인자로 브라우저를 띄운다. 못 띄우면 사유를 담아 throw. */
export async function launchBrowser(extraArgs = []) {
  const pw = loadPlaywright();
  if (!pw) throw new Error(await unavailableReason());
  const exe = await findChromium(pw);
  if (!exe) throw new Error(await unavailableReason());
  return pw.chromium.launch({ executablePath: exe, args: [...CHROMIUM_ARGS, ...extraArgs] });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ply': 'application/octet-stream' };

/** 측정 대상 기본 페이지(dist 루트 기준 URL 경로). 랜딩(index.html)이 아니라 상황판이다. */
export const DEFAULT_ENTRY_PATH = '/res/static/status.html';
/**
 * 기본 상황판 진입 쿼리. relay 는 죽은 주소(ws 오류가 나도 페이지는 계속 부팅, smoke.spec.ts 의 기대 소음)이고,
 * splat=off 는 dist 에 데모 PLY(res/static/demo, vite publicDir 밖)가 없어 기본 splat 요청이 404 로 부팅이 멈추는 것을 피한다.
 */
export const DEAD_RELAY_QUERY = 'splat=off&relay=ws://127.0.0.1:9/stream';

/** inputs.entryPath 를 검증해 돌려준다(없으면 기본값). '/' 로 시작하는 경로여야 한다. */
export function resolveEntryPath(inputs) {
  assertOptionalInputKeys(inputs);
  const p = inputs?.entryPath ?? DEFAULT_ENTRY_PATH;
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || /[?#]/.test(p)) {
    throw new Error(`inputs.entryPath 는 '/' 로 시작하는 URL 경로여야 함(쿼리·해시 불가): ${String(p)}`);
  }
  return p;
}

/**
 * 이미 빌드된 dist 를 http 로 서빙한다. distDir 가 없거나 entryPath 파일이 dist 에 없으면 throw.
 * 반환 url 은 entryPath 를 가리키며, 기본 상황판 경로면 죽은 relay 쿼리를 붙인다.
 */
export async function serveDist(distDir, { entryPath = DEFAULT_ENTRY_PATH } = {}) {
  if (!distDir) throw new Error('input missing: distDir');
  const root = resolve(distDir);
  resolveEntryPath({ entryPath });
  const entryFile = resolve(join(root, normalize(entryPath)));
  if (!entryFile.startsWith(root + sep) || !(await stat(entryFile).catch(() => null))?.isFile()) {
    throw new Error(`distDir 에 entryPath 파일이 없음: ${entryPath} (dist: ${root})`);
  }
  const server = createServer(async (req, res) => {
    try {
      const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      let f = resolve(join(root, p));
      if (f !== root && !f.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      if ((await stat(f).catch(() => null))?.isDirectory()) f = join(f, 'index.html');
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, url: `http://127.0.0.1:${port}${entryPath}${entryPath === DEFAULT_ENTRY_PATH ? `?${DEAD_RELAY_QUERY}` : ''}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

/** 상황판 3D 뷰 캔버스 선택자(skylens develop res/static/status.html 의 canvas#status-view). 2D 미니맵(.minimap__canvas)·영상 패널 캔버스는 대상이 아니다. */
export const DEFAULT_CANVAS_SELECTOR = '#status-view';
/** 관제탑 3D 뷰 캔버스 선택자(develop res/static/control.html 의 canvas#control-view). 관제탑을 측정하려면 entryPath '/res/static/control.html' 과 함께 canvasSelector 로 넘긴다. */
export const CONTROL_CANVAS_SELECTOR = '#control-view';

const OPTIONAL_KEYS = ['entryPath', 'canvasSelector'];
const KNOWN_KEYS = new Set(['pointsPath', 'wsRecording', 'towerRecording', 'distDir', 'anchor', ...OPTIONAL_KEYS]);
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
/** 선택 입력 키(entryPath, canvasSelector)를 잘못 적은 키(대소문자·구분자·1~2자 오타)가 있으면 조용히 기본값으로 가지 않고 throw. 다른 모듈용 키는 통과. */
export function assertOptionalInputKeys(inputs) {
  for (const k of Object.keys(inputs ?? {})) {
    if (KNOWN_KEYS.has(k)) continue;
    const norm = k.toLowerCase().replace(/[-_\s]/g, '');
    for (const opt of OPTIONAL_KEYS) {
      if (norm === opt.toLowerCase() || editDistance(norm, opt.toLowerCase()) <= 2) {
        throw new Error(`알 수 없는 inputs 키 '${k}': '${opt}' 를 뜻하는가? (정확한 이름만 허용)`);
      }
    }
  }
}
/** measureFirstFrame 의 하위 호환 기본값(모든 canvas). 3D 뷰만 판정하려면 canvasSelector 를 넘긴다. */
export const ANY_CANVAS_SELECTOR = 'canvas';

// 첫 프레임 판정 상수. 캔버스를 128x128 로 줄여 가장 흔한 색(배경)과 채널 차이가 8 초과인 픽셀이 0.1% 이상이면 "그려짐".
export const DIFF_RATIO = 0.001;
export const DIFF_TOLERANCE = 8;

/**
 * 페이지 안 첫 프레임 감지 스크립트(addInitScript). 감지 시 window.__ffMs 에 performance.now() 를 기록한다.
 * 비어 있는(배경색 하나로만 채워진) 캔버스는 그려진 것으로 치지 않는다. alpha:false WebGL 의 불투명 clear 도 마찬가지.
 * 측정 대상의 GPU 부하를 늘리지 않도록 preserveDrawingBuffer 를 켜지 않고 매 프레임 readback 도 하지 않는다.
 * WebGL 캔버스는 draw·clear 호출이 있었고 직전 판독 프레임과 draw 서명(호출 수·정점 수)이 달라졌거나 100 ms 가 지난 프레임에서만,
 * 그 draw 와 같은 태스크의 마이크로태스크에서 1회 읽는다(그리기 버퍼가 유효한 시점). 2D 캔버스는 CPU 쪽이라 rAF 마다 읽는다.
 * 폴링 비용: 첫 프레임 감지 전에 매 rAF·마이크로태스크마다 선택자 일치 검사와 이미지 판독을 하므로, 감지 후 WebGL 메서드 래퍼와 getContext 래퍼를 원본 함수로 복원해 오버헤드를 제거한다(동작 검증은 wrapper_delegate.test.mjs).
 */
export function buildDetectScript(selector = ANY_CANVAS_SELECTOR) {
  if (typeof selector !== 'string' || !selector.trim()) throw new Error('canvasSelector 는 비어 있지 않은 CSS 선택자 문자열이어야 함');
  return `(() => {
  const SEL = ${JSON.stringify(selector)};
  const DIFF_RATIO = ${DIFF_RATIO}, TOL = ${DIFF_TOLERANCE}, RECHECK_MS = 100;
  const origGet = HTMLCanvasElement.prototype.getContext;
  const glCanvases = new WeakSet();
  const getContextWrapper = function (type, attrs) {
    const ctx = origGet.call(this, type, attrs);
    if (ctx && /webgl/.test(String(type))) glCanvases.add(this);
    return ctx;
  };
  getContextWrapper.__ffOrig = origGet;
  HTMLCanvasElement.prototype.getContext = getContextWrapper;
  const drawn = (c) => {
    try {
      if (!c.width || !c.height) return false;
      const t = document.createElement('canvas'); t.width = 128; t.height = 128;
      const g = origGet.call(t, '2d', { willReadFrequently: true });
      g.drawImage(c, 0, 0, 128, 128);
      const d = g.getImageData(0, 0, 128, 128).data;
      const n = d.length / 4, cnt = new Map();
      for (let i = 0; i < d.length; i += 4) { const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; cnt.set(k, (cnt.get(k) || 0) + 1); }
      let bg = 0, bn = -1; for (const [k, v] of cnt) if (v > bn) { bn = v; bg = k; }
      const br = bg >> 16, bgc = (bg >> 8) & 255, bb = bg & 255;
      let diff = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - br) > TOL || Math.abs(d[i + 1] - bgc) > TOL || Math.abs(d[i + 2] - bb) > TOL) diff++;
      }
      return diff / n >= DIFF_RATIO;
    } catch (e) { return false; }
  };
  const found = (hit) => {
    window.__ffMs = performance.now();
    window.__ffCanvas = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/).join('.') : '');
    // 감지 후 래퍼를 제거해 원본 함수로 복원(오버헤드 제거). 감지 뒤에는 getContext 로 WebGL 캔버스를 기록할 필요도 없으므로 같이 복원한다.
    // 페이지가 이 메서드를 이미 다시 덮어썼다면 래퍼가 아니므로(__ffOrig 없음, getContext 는 동일성 비교) 그 값은 건드리지 않는다.
    if (HTMLCanvasElement.prototype.getContext === getContextWrapper) HTMLCanvasElement.prototype.getContext = origGet;
    for (const proto of [window.WebGLRenderingContext && WebGLRenderingContext.prototype, window.WebGL2RenderingContext && WebGL2RenderingContext.prototype]) {
      if (!proto) continue;
      for (const name of ['scissor', 'clearColor', 'bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'useProgram', 'bindFramebuffer', 'blendFunc', 'enable', 'disable', 'clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
        // 래퍼일 때만(__ffOrig 가 있을 때) 저장된 원본 함수로 직접 복원.
        if (typeof proto[name] === 'function' && proto[name].__ffOrig) proto[name] = proto[name].__ffOrig;
      }
    }
  };
  // WebGL: draw 호출 서명이 바뀐 프레임에서만 같은 태스크 안에서 1회 판독.
  const sig = new WeakMap(); // canvas -> { cur, read, queued }
  const onDraw = (gl, n) => {
    if (window.__ffMs !== undefined) return;
    const c = gl.canvas;
    if (!(c instanceof HTMLCanvasElement)) return;
    let st = sig.get(c);
    if (!st) { st = { cur: 0, read: -1, at: -1e9, queued: false }; sig.set(c, st); }
    st.cur = (st.cur * 31 + 1 + (n | 0)) | 0;
    if (st.queued) return;
    st.queued = true;
    queueMicrotask(() => {
      st.queued = false;
      if (window.__ffMs !== undefined) return;
      const s = st.cur; st.cur = 0;
      const now = performance.now();
      if (s === st.read && now - st.at < RECHECK_MS) return; // 서명이 같아도 버퍼 내용만 바뀐 경우를 위해 드물게 재판독
      st.read = s; st.at = now;
      try { if (!c.matches(SEL)) return; } catch (e) { return; }
      if (drawn(c)) found(c);
    });
  };
  // 자원·상태 변경(scissor·버퍼·텍스처·프로그램 등)은 draw 서명에 섞어 같은 호출 수라도 내용이 바뀐 프레임을 후보로 만든다(uniform 은 제외, 매 프레임 바뀜).
  for (const proto of [window.WebGLRenderingContext && WebGLRenderingContext.prototype, window.WebGL2RenderingContext && WebGL2RenderingContext.prototype]) {
    if (!proto) continue;
    for (const name of ['scissor', 'clearColor', 'bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'useProgram', 'bindFramebuffer', 'blendFunc', 'enable', 'disable']) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;
      const wrapped = function (...a) {
        if (window.__ffMs !== undefined) return orig.apply(this, a); // 감지 뒤 남아 있는 래퍼(페이지가 원본을 캡처한 경우)는 해시 없이 위임
        // 이 조기 반환(:233·:250)을 지워도 테스트가 실패하지 않는다(F-055 ②, 미해결): 해시 경로가 감지 뒤에도 값만 갱신할 뿐 결과가 같아 관측 가능한 차이가 없다. 성능 주장만 한다.
        const r = orig.apply(this, a);
        const st = sig.get(this.canvas);
        if (st) st.cur = (st.cur * 17 + name.length + (typeof a[0] === 'number' ? a[0] : 0)) | 0;
        else if (this.canvas instanceof HTMLCanvasElement) sig.set(this.canvas, { cur: name.length, read: -1, at: -1e9, queued: false });
        return r;
      };
      wrapped.__ffOrig = orig;
      proto[name] = wrapped;
    }
  }
  for (const proto of [window.WebGLRenderingContext && WebGLRenderingContext.prototype, window.WebGL2RenderingContext && WebGL2RenderingContext.prototype]) {
    if (!proto) continue;
    for (const name of ['clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;
      const wrapped = function (...a) {
        if (window.__ffMs !== undefined) return orig.apply(this, a); // 감지 뒤 남아 있는 래퍼(페이지가 원본을 캡처한 경우)는 해시 없이 위임
        const r = orig.apply(this, a);
        onDraw(this, name === 'clear' ? a[0] : name === 'drawRangeElements' ? a[4] : a[name.startsWith('drawArrays') ? 2 : 1]);
        return r;
      };
      wrapped.__ffOrig = orig;
      proto[name] = wrapped;
    }
  }
  const tick = () => {
    if (window.__ffMs !== undefined) return;
    let hit = null;
    try { hit = [...document.querySelectorAll(SEL)].find((e) => e instanceof HTMLCanvasElement && !glCanvases.has(e) && drawn(e)) || null; } catch (e) { hit = null; }
    if (hit) { found(hit); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;
}
export const DETECT_SCRIPT = buildDetectScript();

/**
 * 새 컨텍스트에서 url 을 열고 첫 프레임 시각(ms, 탐색 시작 기준)을 반환한다. 시간 안에 감지하지 못하면 throw.
 * canvasSelector 로 판정 대상 캔버스를 한정한다(기본 'canvas' = 모든 캔버스, 하위 호환). 반환의 canvas 는 판정한 요소 표기(예 canvas#status-view).
 * after(page) 가 있으면 첫 프레임 감지 직후 호출해 그 결과를 { ms, canvas, after } 로 돌려준다.
 */
export async function measureFirstFrame(browser, url, { timeoutMs = 30000, after, canvasSelector = ANY_CANVAS_SELECTOR } = {}) {
  const script = buildDetectScript(canvasSelector);
  const ctx = await browser.newContext(); // 캐시 없는 새 컨텍스트
  try {
    const page = await ctx.newPage();
    await page.addInitScript(script);
    await page.goto(url, { waitUntil: 'commit' });
    try {
      await page.waitForFunction(() => window.__ffMs !== undefined, null, { timeout: timeoutMs, polling: 10 });
    } catch {
      throw new Error(`첫 프레임 미감지(${timeoutMs} ms 안에 선택자 ${canvasSelector} 캔버스에 배경색과 다른 픽셀이 그려지지 않음): ${url}`);
    }
    const { ms, canvas } = await page.evaluate(() => ({ ms: window.__ffMs, canvas: window.__ffCanvas }));
    return after ? { ms, canvas, after: await after(page) } : { ms, canvas };
  } finally { await ctx.close(); }
}
