// 첫 프레임 시간 기준선 (T01.6). 헤드리스 Chromium(소프트웨어 렌더)으로 5회 측정한다. 결과는 참고값이다.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync, execFile } from 'node:child_process';
import { readFile, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize, resolve, sep } from 'node:path';

export const RUNS = 5;
const PW_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

/** 중앙값. 빈 배열이면 오류. 짝수 개면 가운데 두 값의 평균. */
export function median(xs) {
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('median: 빈 입력');
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 표본 분산(ms^2). n-1 로 나눈다. 표본이 1개면 0. */
export function variance(xs) {
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('variance: 빈 입력');
  if (xs.length === 1) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
}

/** 페이지 안에서 첫 프레임을 감지하는 스크립트. 감지 시 window.__ffMs 에 performance.now() 를 기록한다. */
export const DETECT_SCRIPT = `(() => {
  const nonBlank = (c) => {
    try {
      if (!c.width || !c.height) return false;
      const t = document.createElement('canvas'); t.width = Math.min(c.width, 64); t.height = Math.min(c.height, 64);
      const g = t.getContext('2d'); g.drawImage(c, 0, 0, t.width, t.height);
      const d = g.getImageData(0, 0, t.width, t.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
    } catch (e) {}
    return false;
  };
  const tick = () => {
    if (window.__ffMs !== undefined) return;
    if (window.__firstFrame || [...document.querySelectorAll('canvas')].some(nonBlank)) {
      window.__ffMs = performance.now();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** 디렉터리를 서빙하는 로컬 정적 서버. */
export async function serveDir(dir) {
  const root = resolve(dir);
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
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

async function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const paths = ['playwright', '/node-tools/node_modules/playwright'];
  try { paths.push(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')); } catch { /* npm 없음 */ }
  for (const p of paths) {
    try { return req(p); } catch { /* 다음 후보 */ }
  }
  return null;
}

/** PLAYWRIGHT_BROWSERS_PATH 아래 chromium 실행파일 경로. 없으면 null. */
export async function findChromium() {
  const dirs = await readdir(PW_PATH).catch(() => []);
  const cands = dirs.filter((d) => /^chromium(_headless_shell)?(-\d+)?$/.test(d)).sort().reverse();
  for (const d of cands) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const f = join(PW_PATH, d, rel);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

const ARGS = ['--headless', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'];

async function measureWithPlaywright(pw, exe, url, n) {
  const browser = await pw.chromium.launch({ executablePath: exe, args: ARGS });
  const out = [];
  try {
    for (let i = 0; i < n; i++) {
      const ctx = await browser.newContext(); // 매 회 새 컨텍스트(캐시 없음)
      const page = await ctx.newPage();
      await page.addInitScript(DETECT_SCRIPT);
      await page.goto(url, { waitUntil: 'commit' });
      await page.waitForFunction(() => window.__ffMs !== undefined, null, { timeout: 30000, polling: 10 });
      out.push(await page.evaluate(() => window.__ffMs));
      await ctx.close();
    }
  } finally { await browser.close(); }
  return out;
}

// playwright 가 없을 때의 대체 경로: 내장 --dump-dom 만 사용한다. 페이지가 body 의 data-ff-ms 에 시각을 쓰는 경우에만 동작한다.
async function measureWithDumpDom(exe, url, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const tmp = `--user-data-dir=${join(process.env.TMPDIR || '/tmp', `ff-${process.pid}-${i}`)}`;
    const stdout = await new Promise((ok, ko) => execFile(exe, [...ARGS, tmp, '--virtual-time-budget=5000', '--dump-dom', url], { maxBuffer: 1 << 26, timeout: 60000 }, (e, so) => (e ? ko(e) : ok(so))));
    const m = /data-ff-ms="([0-9.]+)"/.exec(stdout);
    if (!m) throw new Error('dump-dom 대체 경로: 첫 프레임 시각을 얻지 못함(페이지가 data-ff-ms 를 쓰지 않음)');
    out.push(Number(m[1]));
  }
  return out;
}

export async function run({ skylensDir, outDir, commit, url } = {}) {
  const exe = await findChromium();
  if (!exe) throw new Error(`Chromium 을 ${PW_PATH} 에서 찾지 못함`);
  let server = null;
  let target = url;
  if (!target) {
    if (!skylensDir) throw new Error('url 또는 skylensDir 필요');
    server = await serveDir(join(skylensDir, 'dist'));
    target = `http://127.0.0.1:${server.port}/index.html`;
  }
  try {
    const pw = await loadPlaywright();
    const samples = pw ? await measureWithPlaywright(pw, exe, target, RUNS) : await measureWithDumpDom(exe, target, RUNS);
    const device = 'headless-chromium-software-render (참고값)';
    const how = `${pw ? 'playwright' : 'chromium --dump-dom'} ${RUNS}회, 새 컨텍스트, 첫 rAF 이후 캔버스 비어있지 않음 또는 window.__firstFrame, 소프트웨어 렌더라 참고값`;
    const records = [
      { metric: 'first_frame.median', value: median(samples), unit: 'ms', device, method: `${how}; 중앙값 단위 ms`, commit, samples },
      // 계약 UNITS 에 ms^2 가 없어 가장 가까운 'ratio' 를 쓰고 metric 에 sq 를 붙인다.
      { metric: 'first_frame.variance_sq', value: variance(samples), unit: 'ratio', device, method: `${how}; 표본 분산(n-1), 실제 단위 ms^2`, commit, samples },
    ];
    if (outDir) {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, 'first_frame.json'), JSON.stringify(records, null, 2) + '\n');
    }
    return records;
  } finally { if (server) await server.close(); }
}
