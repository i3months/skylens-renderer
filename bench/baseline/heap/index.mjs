// T01.7: JS heap of the skylens status view after the first frame with demo segments loaded.
// Method: real app, headless Chromium (swiftshader). Vite dev server + client relay + the repo's
// scripted fake core streaming the real demo assets (res/static/demo) are started on free ports from a
// temp copy of skylens. The page is loaded, we wait until all 4 demo segments reached their final
// level, two animation frames plus a settle period, force GC via CDP, then read
// performance.memory.usedJSHeapSize (--enable-precise-memory-info). 5 fresh browsers; median.
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';

const SAMPLES = 5;
const SETTLE_MS = 3000;
const SEGMENTS = 4;
const FINAL_LEVEL = 4;

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    if (Date.now() > end) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function oneSample(chromium, url) {
  const browser = await chromium.launch({
    executablePath: process.env.SKYLENS_CHROMIUM ?? '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => window.skylens?.role === 'status', undefined, { timeout: 120_000 });
    await page.waitForFunction(
      ([n, lv]) => {
        const l = window.skylens.splat?.segmentLevels ?? {};
        return Object.keys(l).length >= n && Object.values(l).every((v) => v >= lv);
      },
      [SEGMENTS, FINAL_LEVEL],
      { timeout: 180_000, polling: 250 },
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(SETTLE_MS);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    return await page.evaluate(() => performance.memory.usedJSHeapSize);
  } finally {
    await browser.close();
  }
}

export async function run({ skylensDir, outDir, commit }) {
  const src = resolve(skylensDir);
  const require = createRequire(join(src, 'package.json'));
  const { chromium } = require('playwright');
  const work = await mkdtemp(join(tmpdir(), 'heap-'));
  const sk = join(work, 'sk');
  await mkdir(sk);
  await cp(src, sk, { recursive: true, filter: (p) => !/^[\\/](node_modules|\.git)([\\/]|$)/.test(p.slice(src.length)) });
  await symlink(join(src, 'node_modules'), join(sk, 'node_modules'));
  const [core, vite, client] = [await freePort(), await freePort(), await freePort()];
  const kids = [];
  const start = (args, env) =>
    kids.push(spawn(process.execPath, args, { cwd: sk, env: { ...process.env, ...env }, stdio: 'ignore' }));
  const tsx = ['--import', 'tsx'];
  try {
    start([...tsx, 'src/test/client/fakeCore.ts'], { FAKE_CORE_PORT: String(core) });
    start(['node_modules/vite/bin/vite.js', '--port', String(vite), '--strictPort', '--host', '127.0.0.1'], {});
    start([...tsx, 'src/skylens_client/server/index.ts'], {
      SKYLENS_CLIENT_PORT: String(client),
      SKYLENS_CORE_WS: `ws://localhost:${core}/viewer`,
      SKYLENS_VITE_URL: `http://127.0.0.1:${vite}`,
    });
    await waitHttp(`http://127.0.0.1:${client}/health`, 60_000);
    const url = `http://127.0.0.1:${client}/res/static/status.html`;
    await waitHttp(`http://127.0.0.1:${vite}/res/static/status.html`, 120_000);

    const samples = [];
    for (let i = 0; i < SAMPLES; i++) samples.push(await oneSample(chromium, url));
    const records = assertRecords([
      {
        metric: 'heap.status.js_bytes',
        value: median(samples),
        unit: 'B',
        device: 'headless-chromium swiftshader 1440x900',
        method: `full status.html via vite dev + client relay + fakeCore (real demo segments, ${SEGMENTS} segments at level ${FINAL_LEVEL}); +2 rAF, ${SETTLE_MS}ms settle, CDP HeapProfiler.collectGarbage, performance.memory.usedJSHeapSize with --enable-precise-memory-info; median of ${SAMPLES} fresh browsers; dev (unminified) bundle`,
        commit,
        samples,
      },
    ]);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'heap.json'), serialize(records));
    return records;
  } finally {
    for (const k of kids) k.kill('SIGTERM');
    await rm(work, { recursive: true, force: true });
  }
}
