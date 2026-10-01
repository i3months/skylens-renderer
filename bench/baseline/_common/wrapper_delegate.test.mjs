// 감지 후 래퍼 복원 테스트. 실제 chromium 페이지에서, 첫 프레임 감지 전에는 WebGL 메서드·getContext 가 래퍼이고
// 감지 뒤에는 모두 원본(__ffOrig 없음, 네이티브 함수)으로 복원되며 페이지의 그리기 호출이 계속 동작하는지를 동작으로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveDist, launchBrowser, measureFirstFrame, buildDetectScript, unavailableReason } from './browser.mjs';

const reason = process.platform !== 'linux' ? 'linux 전용(swiftshader 인자)' : await unavailableReason();
if (reason) console.log(`# 브라우저 테스트 skip 사유: ${reason}`);
const opts = { skip: reason ?? false };

const WRAPPED = ['scissor', 'clearColor', 'bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'useProgram', 'bindFramebuffer', 'blendFunc', 'enable', 'disable',
  'clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];

// drawDelayMs 가 null 이면 그리지 않는다(감지되지 않음).
const GL = (drawDelayMs, pre = '') => `<!doctype html><body style="margin:0"><canvas id=c width=200 height=200></canvas><script>${pre}
const gl = document.getElementById('c').getContext('webgl', { alpha: false });
gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
window.draw = () => { gl.enable(gl.SCISSOR_TEST); gl.scissor(40, 40, 80, 80); gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); };
${drawDelayMs === null ? '' : `setTimeout(window.draw, ${drawDelayMs});`}
</script>`;

// 페이지 안에서 래퍼 상태를 조사한다. 래퍼는 __ffOrig 를 가지며, 복원된 원본은 네이티브 함수다.
const inspect = (names) => {
  const isNative = (f) => /\[native code\]/.test(Function.prototype.toString.call(f));
  const out = { methods: {}, getContext: null };
  for (const [pn, C] of Object.entries({ WebGLRenderingContext, WebGL2RenderingContext })) {
    for (const n of names) {
      const f = C.prototype[n];
      if (typeof f === 'function') out.methods[`${pn}.${n}`] = { wrapped: f.__ffOrig !== undefined, native: isNative(f) };
    }
  }
  const g = HTMLCanvasElement.prototype.getContext;
  out.getContext = { wrapped: g.__ffOrig !== undefined, native: isNative(g) };
  return out;
};

async function withPage(html, fn) {
  const dist = await mkdtemp(join(tmpdir(), 'wd-'));
  try {
    await mkdir(join(dist, 'res/static'), { recursive: true });
    await writeFile(join(dist, 'res/static/status.html'), html);
    const s = await serveDist(dist);
    const b = await launchBrowser();
    try { return await fn(b, s.url); } finally { await b.close(); await s.close(); }
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
}

test('감지 뒤: 모든 WebGL 메서드와 getContext 가 원본으로 복원되고 그리기는 계속 동작', opts, async () => {
  const { after } = await withPage(GL(0), (b, url) => measureFirstFrame(b, url, {
    timeoutMs: 10000,
    after: async (page) => ({
      state: await page.evaluate(inspect, WRAPPED),
      glError: await page.evaluate(() => { window.draw(); return document.getElementById('c').getContext('webgl').getError(); }),
      newCtx: await page.evaluate(() => document.createElement('canvas').getContext('2d') !== null),
    }),
  }));
  assert.ok(Object.keys(after.state.methods).length >= WRAPPED.length, '검사한 메서드가 너무 적음');
  for (const [n, st] of Object.entries(after.state.methods)) {
    assert.equal(st.wrapped, false, `${n} 가 감지 뒤에도 래퍼(__ffOrig 존재)`);
    assert.equal(st.native, true, `${n} 가 네이티브 함수가 아님`);
  }
  assert.deepEqual(after.state.getContext, { wrapped: false, native: true });
  assert.equal(after.glError, 0); // gl.NO_ERROR
  assert.equal(after.newCtx, true);
});

test('감지 전(대조): 그리지 않으면 같은 메서드들이 래퍼 상태로 남는다', opts, async () => {
  // 래퍼가 실제로 설치돼 있음을 보여, 위 테스트가 처음부터 래퍼가 없어서 통과하는 일을 막는다.
  await withPage(GL(null), async (b, url) => {
    const ctx = await b.newContext();
    try {
      const page = await ctx.newPage();
      await page.addInitScript(buildDetectScript('#c'));
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => window.__ffMs), undefined);
      const st = await page.evaluate(inspect, WRAPPED);
      for (const [n, m] of Object.entries(st.methods)) assert.equal(m.wrapped, true, `${n} 는 감지 전에 래퍼여야 함`);
      assert.equal(st.getContext.wrapped, true);
    } finally { await ctx.close(); }
  });
});

test('페이지가 먼저 덮어쓴 getContext 는 감지 뒤 복원이 건드리지 않는다', opts, async () => {
  const pre = 'setTimeout(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (...a) { window.pageWrapped = true; return g.apply(this, a); }; }, 100);';
  const { after } = await withPage(GL(400, pre), (b, url) => measureFirstFrame(b, url, {
    timeoutMs: 10000,
    after: (page) => page.evaluate(() => { document.createElement('canvas').getContext('2d'); return window.pageWrapped === true; }),
  }));
  assert.equal(after, true);
});
