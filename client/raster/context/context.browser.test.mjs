// 헤드리스 Chromium(SwiftShader) 실제 WebGL2 초기화·소실·복구 시험. 브라우저나 playwright 가 없으면 skip 하고 이유를 남긴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createContext } from './index.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

let chromium = null;
let skipReason = null;
try {
  const require = createRequire(import.meta.url);
  const paths = ['playwright', '/opt/node-tools/node_modules/playwright'];
  for (const p of paths) {
    try { ({ chromium } = require(p)); break; } catch { /* 다음 후보 */ }
  }
  if (!chromium) skipReason = 'playwright 모듈을 찾지 못함';
} catch (e) { skipReason = `playwright 로드 실패: ${e.message}`; }

let browser = null;
if (!skipReason) {
  try {
    browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  } catch (e) { skipReason = `Chromium 실행 실패: ${e.message.split('\n')[0]}`; }
}
if (skipReason) console.log(`# browser 시험 skip: ${skipReason}`);

test('헤드리스 소프트웨어 렌더에서 초기화·소실·복구', { skip: skipReason ?? false }, async (t) => {
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('about:blank');
  // 모듈을 페이지에 문자열로 싣는다(import 경로 없이): createContext 소스에서 import 줄을 떼어 쓴다.
  const fs = await import('node:fs');
  let src = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  src = src.replace(/^import .*$/m, 'class ClientRasterError extends Error { constructor(c, m) { super(m); this.code = c; } }')
    .replace('export function', 'function');
  const r = await page.evaluate(async (code) => {
    const createContext = new Function(`${code}; return createContext;`)();
    const canvas = document.createElement('canvas');
    canvas.width = 16; canvas.height = 16;
    document.body.appendChild(canvas);
    const ctx = createContext({ canvas });
    const gl = ctx.gl;
    const out = { version: gl.getParameter(gl.VERSION), isGl2: gl instanceof WebGL2RenderingContext };
    gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.px = Array.from(px);
    const ext = gl.getExtension('WEBGL_lose_context');
    out.hasExt = !!ext;
    if (ext) {
      const log = [];
      ctx.onLost(() => log.push('lost'));
      const restored = new Promise((res) => ctx.onRestored(() => { log.push('restored'); res(); }));
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 0));
      out.lostAfter = ctx.isLost();
      ext.restoreContext();
      await restored;
      out.lostEnd = ctx.isLost();
      out.log = log;
    }
    ctx.dispose();
    return out;
  }, src);
  assert.ok(r.isGl2);
  assert.match(r.version, /WebGL 2/);
  assert.deepEqual(r.px, [255, 0, 0, 255]);
  assert.equal(r.hasExt, true);
  assert.equal(r.lostAfter, true);
  assert.equal(r.lostEnd, false);
  assert.deepEqual(r.log, ['lost', 'restored']);
});
