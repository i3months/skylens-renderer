// Baseline T01.6: headless-browser first-frame time of the skylens status view.
//
// Setup (all local, skylens checkout is copied, never modified):
//   vite dev server + skylens_core stand-in (src/test/client/fakeCore.ts, streams the
//   real demo segment assets) + skylens_client relay -> status.html in headless
//   Chromium with SwiftShader (software GL).
// Metric: ms from navigation start (performance.timeOrigin) until the board has
//   received geometry (first splat chunk), the splat viewer reports 'ready', and two
//   animation frames have been presented afterwards. Each run uses a fresh browser
//   context (cold HTTP cache); one untimed warm-up run primes Vite's transform cache.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import net from 'node:net';
import path from 'node:path';

export const METRIC = 'first_frame.status.ms';
export const RUNS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function variance(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

async function waitFor(fn, what, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(300);
  }
}

const INIT_SCRIPT = `(() => {
  const poll = () => {
    const s = window.skylens && window.skylens.splat;
    if (s && s.hasGeometry && s.status === 'ready') {
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__firstFrameMs = performance.now(); }));
      return;
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
})();`;

// Share of pixels clearly brighter than the dark board background; the splat scene
// fills the view, so a rendered splat lifts this well above an empty board.
async function litFraction(page, png) {
  const b64 = png.toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + data;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11 > 60) lit++;
    return lit / (px.length / 4);
  }, b64);
}

export async function run({ skylensDir, outDir, commit }) {
  mkdirSync(outDir, { recursive: true });
  const work = path.join(outDir, 'skylens-copy');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // Copy (not symlink): vite writes its dep cache into node_modules/.vite.
  execFileSync('sh', ['-c', 'tar cf - --exclude=./.git --exclude=./src/skylens_model -C "$1" . | tar xf - -C "$2"', 'sh', skylensDir, work]);
  const require = createRequire(path.join(skylensDir, 'package.json'));
  const { chromium } = require('playwright');

  const [vitePort, corePort, clientPort] = [await freePort(), await freePort(), await freePort()];
  const procs = [];
  const logs = {};
  const start = (name, cmd, args, env) => {
    const p = spawn(cmd, args, { cwd: work, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    logs[name] = '';
    p.stdout.on('data', (d) => (logs[name] += d));
    p.stderr.on('data', (d) => (logs[name] += d));
    procs.push(p);
    return p;
  };
  const bin = (n) => path.join(work, 'node_modules', '.bin', n);
  let browser;
  try {
    start('vite', bin('vite'), ['--port', String(vitePort), '--strictPort', '--host', '127.0.0.1']);
    start('core', bin('tsx'), ['src/test/client/fakeCore.ts'], { FAKE_CORE_PORT: String(corePort), FAKE_FIRST: '0.2' });
    start('client', bin('tsx'), ['src/skylens_client/server/index.ts'], {
      SKYLENS_CLIENT_PORT: String(clientPort),
      SKYLENS_CORE_WS: `ws://127.0.0.1:${corePort}/viewer`,
      SKYLENS_VITE_URL: `http://127.0.0.1:${vitePort}`,
    });
    const health = () => fetch(`http://127.0.0.1:${clientPort}/health`).then((r) => r.json());
    // The relay caches the stream; wait until the whole demo ladder has been cached
    // so every run sees the same board state.
    await waitFor(async () => (await health()).relayed.cached.segments >= 4, 'demo stream cached by relay', 120_000);
    await waitFor(() => /seg3 lv4/.test(logs.core), 'last demo chunk', 120_000);
    await sleep(500);

    browser = await chromium.launch({
      executablePath: '/opt/pw-browsers/chromium',
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
    });
    const url = `http://127.0.0.1:${clientPort}/res/static/status.html?reveal=off&spin=off`;
    const once = async () => {
      const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
      try {
        const page = await ctx.newPage();
        await page.addInitScript(INIT_SCRIPT);
        await page.goto(url, { waitUntil: 'commit' });
        await page.waitForFunction('window.__firstFrameMs !== undefined', null, { timeout: 120_000, polling: 100 });
        const ms = await page.evaluate('window.__firstFrameMs');
        const shot = await page.screenshot({ timeout: 120_000 });
        const helper = await ctx.newPage();
        const lit = await litFraction(helper, shot);
        return { ms, lit };
      } finally {
        await ctx.close();
      }
    };
    await once(); // warm-up (untimed): primes Vite transforms and optimized deps
    const samples = [];
    const lit = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await once();
      samples.push(Math.round(r.ms * 10) / 10);
      lit.push(Math.round(r.lit * 1000) / 1000);
    }
    const med = median(samples);
    const varc = variance(samples);
    writeFileSync(path.join(outDir, 'first_frame.detail.json'), JSON.stringify({ samples, median: med, variance: varc, litFraction: lit, url }, null, 2) + '\n');
    const cpu = cpus()[0]?.model?.trim() ?? 'unknown cpu';
    return [
      {
        metric: METRIC,
        value: med,
        unit: 'ms',
        device: `headless Chromium, SwiftShader software GL (no GPU), 640x360, ${cpus().length} vCPU ${cpu}`,
        method:
          'Full skylens status.html (vite dev + fake core streaming demo segment PLYs + client relay, develop copy) in headless Chromium; ' +
          'ms from navigation start to first splat chunk received + splat viewer ready + 2 animation frames, ?reveal=off&spin=off; ' +
          `median of ${RUNS} runs after 1 untimed warm-up, fresh browser context each; sample variance ${varc.toFixed(1)} ms^2 (stddev ${Math.sqrt(varc).toFixed(1)} ms); ` +
          'relay replays cached stream so chunk arrival is not paced by core; dev-mode (unbundled) page, not a production build',
        commit,
        samples,
      },
    ];
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const p of procs) {
      try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(work, { recursive: true, force: true });
  }
}
