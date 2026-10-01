import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEntryPath, assertOptionalInputKeys, DEFAULT_CANVAS_SELECTOR, CONTROL_CANVAS_SELECTOR, DEFAULT_ENTRY_PATH, serveDist, launchBrowser, measureFirstFrame, buildDetectScript, unavailableReason, CHROMIUM_ARGS, DEVICE } from './browser.mjs';

async function page(html) {
  const dir = await mkdtemp(join(tmpdir(), 'bc-'));
  await mkdir(join(dir, 'res/static'), { recursive: true });
  await writeFile(join(dir, 'res/static/status.html'), html);
  return dir;
}

const GL = (alpha, drawDelayMs) => `<!doctype html><body style="margin:0"><canvas id=c width=200 height=200></canvas><script>
const gl = document.getElementById('c').getContext('webgl', { alpha: ${alpha} });
gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
const draw = () => { gl.enable(gl.SCISSOR_TEST); gl.scissor(40, 40, 80, 80); gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); };
${drawDelayMs === null ? '' : `setTimeout(draw, ${drawDelayMs});`}
</script>`;

test('serveDist: distDir 없음/ entryPath 파일 없음은 오류', async () => {
  await assert.rejects(() => serveDist(undefined), /distDir/);
  const empty = await mkdtemp(join(tmpdir(), 'bc-'));
  await writeFile(join(empty, 'index.html'), '<p>landing</p>');
  await assert.rejects(() => serveDist(empty), /\/res\/static\/status\.html/);
  await assert.rejects(() => serveDist(empty, { entryPath: '/../x.html' }), /entryPath|없음/);
});

test('resolveEntryPath: 기본값과 형식 검증', () => {
  assert.equal(DEFAULT_ENTRY_PATH, '/res/static/status.html');
  assert.equal(resolveEntryPath({}), '/res/static/status.html');
  assert.equal(resolveEntryPath(undefined), '/res/static/status.html');
  assert.equal(resolveEntryPath({ entryPath: '/index.html' }), '/index.html');
  for (const bad of ['index.html', '//evil/x', '/a.html?x=1', '', 5]) assert.throws(() => resolveEntryPath({ entryPath: bad }), /entryPath/);
});

test('serveDist: http 로 서빙하고 없는 파일은 404', async () => {
  const dir = await page('<p>hi</p>');
  const s = await serveDist(dir);
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/res\/static\/status\.html\?splat=off&relay=ws:\/\/127\.0\.0\.1:9\/stream$/);
    assert.equal(await (await fetch(s.url)).text(), '<p>hi</p>');
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/nope.js`)).status, 404);
  } finally { await s.close(); }
});

test('공용 인자: swiftshader 와 device 라벨', () => {
  assert.ok(CHROMIUM_ARGS.includes('--use-gl=swiftshader'));
  assert.match(DEVICE, /swiftshader/);
});

const reason = await unavailableReason();
if (reason) console.log(`# 브라우저 테스트 skip 사유: ${reason}`);
const opts = { skip: reason ?? false };

async function measure(html, o) {
  const s = await serveDist(await page(html));
  const b = await launchBrowser();
  try { return await measureFirstFrame(b, s.url, o); } finally { await b.close(); await s.close(); }
}

test('음성: 그리지 않는 alpha:false WebGL 캔버스(불투명 clear 만)는 미감지', opts, async () => {
  await assert.rejects(() => measure(GL(false, null), { timeoutMs: 2000 }), /첫 프레임 미감지/);
});

test('음성: 빈 2D 캔버스(단색 채움)는 미감지', opts, async () => {
  await assert.rejects(() => measure('<canvas id=c width=100 height=100></canvas><script>const g=c.getContext("2d");g.fillStyle="#123";g.fillRect(0,0,100,100)</script>', { timeoutMs: 2000 }), /첫 프레임 미감지/);
});

test('양성: 500 ms 뒤 그리는 alpha:false WebGL 은 500 ms 이상 2500 ms 미만', opts, async () => {
  const { ms } = await measure(GL(false, 500), { timeoutMs: 10000 });
  assert.ok(ms >= 500 && ms < 2500, `ms ${ms}`);
});

test('양성: 500 ms 뒤 그리는 2D 캔버스는 500 ms 이상 2500 ms 미만', opts, async () => {
  const { ms } = await measure('<canvas id=c width=100 height=100></canvas><script>const g=c.getContext("2d");g.fillStyle="#000";g.fillRect(0,0,100,100);setTimeout(()=>{g.fillStyle="#f00";g.fillRect(10,10,50,50)},500)</script>', { timeoutMs: 10000 });
  assert.ok(ms >= 500 && ms < 2500, `ms ${ms}`);
});

test('양성: 바로 그리는 페이지는 2500 ms 미만에 감지', opts, async () => {
  const { ms } = await measure(GL(false, 0), { timeoutMs: 10000 });
  assert.ok(ms > 0 && ms < 2500, `ms ${ms}`);
});

test('양성: drawArrays 로 삼각형을 그리는 WebGL(preserveDrawingBuffer 없음)도 감지', opts, async () => {
  const html = `<!doctype html><canvas id=c width=200 height=200></canvas><script>
const gl = document.getElementById('c').getContext('webgl');
const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
const pr = gl.createProgram();
gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, 'void main(){gl_FragColor=vec4(1.,0.,0.,1.);}'));
gl.linkProgram(pr); gl.useProgram(pr);
const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.8,-0.8, 0.8,-0.8, 0,0.8]), gl.STATIC_DRAW);
const l = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
const frame = () => { gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3); requestAnimationFrame(frame); };
setTimeout(frame, 300);
</script>`;
  const { ms } = await measure(html, { timeoutMs: 10000 });
  assert.ok(ms >= 300 && ms < 2500, `ms ${ms}`);
});

test('감지 스크립트는 preserveDrawingBuffer 를 강제하지 않는다(측정 대상 GPU 부하 불변)', opts, async () => {
  const s = await serveDist(await page(GL(false, 0)));
  const b = await launchBrowser();
  try {
    const { after } = await measureFirstFrame(b, s.url, { timeoutMs: 10000, after: (p) => p.evaluate(() => document.getElementById('c').getContext('webgl').getContextAttributes().preserveDrawingBuffer) });
    assert.equal(after, false);
  } finally { await b.close(); await s.close(); }
});

test('감지 스크립트 소스: preserveDrawingBuffer 를 켜지 않고 WebGL 은 draw·clear 후보 프레임에서만 읽는다', () => {
  const src = buildDetectScript('#c');
  assert.doesNotMatch(src, /preserveDrawingBuffer\s*:\s*true/);
  assert.match(src, /queueMicrotask/);
});

test('assertOptionalInputKeys: 정확한 키와 다른 모듈용 키는 통과, 오타 키는 거부', () => {
  assertOptionalInputKeys({ distDir: 'd', entryPath: '/a', canvasSelector: '#a', anchor: {} });
  assertOptionalInputKeys(undefined);
  for (const k of ['entrypath', 'entry_path', 'canvasselector', 'canvas-selector', 'canvasSelecter']) {
    assert.throws(() => assertOptionalInputKeys({ [k]: 'x' }), /알 수 없는 inputs 키/, k);
  }
  assert.throws(() => resolveEntryPath({ entrypath: '/a.html' }), /entryPath/);
});

test('기본 캔버스 선택자: 상황판 #status-view, 관제탑 #control-view', () => {
  assert.equal(DEFAULT_CANVAS_SELECTOR, '#status-view');
  assert.equal(CONTROL_CANVAS_SELECTOR, '#control-view');
});
