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

// 첫 프레임 판정 상수. 캔버스를 128x128 로 줄여 가장 흔한 색(배경)과 채널 차이가 8 초과인 픽셀이 0.1% 이상이면 "그려짐".
export const DIFF_RATIO = 0.001;
export const DIFF_TOLERANCE = 8;

/**
 * 페이지 안 첫 프레임 감지 스크립트(addInitScript). 감지 시 window.__ffMs 에 performance.now() 를 기록한다.
 * 비어 있는(배경색 하나로만 채워진) 캔버스는 그려진 것으로 치지 않는다. alpha:false WebGL 의 불투명 clear 도 마찬가지.
 * WebGL 캔버스를 읽을 수 있도록 preserveDrawingBuffer 를 켠다.
 */
export const DETECT_SCRIPT = `(() => {
  const DIFF_RATIO = ${DIFF_RATIO}, TOL = ${DIFF_TOLERANCE};
  const origGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (/webgl/.test(type)) attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    return origGet.call(this, type, attrs);
  };
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
  const tick = () => {
    if (window.__ffMs !== undefined) return;
    if ([...document.querySelectorAll('canvas')].some(drawn)) { window.__ffMs = performance.now(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

/**
 * 새 컨텍스트에서 url 을 열고 첫 프레임 시각(ms, 탐색 시작 기준)을 반환한다. 시간 안에 감지하지 못하면 throw.
 * after(page) 가 있으면 첫 프레임 감지 직후 호출해 그 결과를 { ms, after } 로 돌려준다.
 */
export async function measureFirstFrame(browser, url, { timeoutMs = 30000, after } = {}) {
  const ctx = await browser.newContext(); // 캐시 없는 새 컨텍스트
  try {
    const page = await ctx.newPage();
    await page.addInitScript(DETECT_SCRIPT);
    await page.goto(url, { waitUntil: 'commit' });
    try {
      await page.waitForFunction(() => window.__ffMs !== undefined, null, { timeout: timeoutMs, polling: 10 });
    } catch {
      throw new Error(`첫 프레임 미감지(${timeoutMs} ms 안에 배경색과 다른 픽셀이 그려지지 않음): ${url}`);
    }
    const ms = await page.evaluate(() => window.__ffMs);
    return after ? { ms, after: await after(page) } : { ms };
  } finally { await ctx.close(); }
}
