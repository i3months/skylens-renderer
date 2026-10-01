import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { median, stddev, run, RUNS, resolveCanvasSelector } from './index.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { unavailableReason, DEVICE } from '../_common/browser.mjs';

test('median: 기준 숫자', () => {
  assert.equal(median([1, 2, 3, 4, 100]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.throws(() => median([]));
});

test('stddev: 기준 숫자(표본 표준편차, ms)', () => {
  assert.ok(Math.abs(stddev([1, 2, 3, 4, 5]) - Math.sqrt(2.5)) < 1e-12);
  assert.equal(stddev([5, 5, 5]), 0);
  assert.equal(stddev([3]), 0);
  assert.ok(Math.abs(stddev([2, 4, 4, 4, 5, 5, 7, 9]) - Math.sqrt(32 / 7)) < 1e-12);
  assert.throws(() => stddev([]));
});

test('run: inputs.distDir 없으면 throw(합성 대체 없음)', async () => {
  await assert.rejects(() => run({ commit: 'abcdef1', inputs: {} }), /input missing: distDir/);
  await assert.rejects(() => run({ commit: 'abcdef1' }), /input missing: distDir/);
});

const reason = await unavailableReason();
if (reason) console.log(`# 브라우저 테스트 skip 사유: ${reason}`);

test('dist 를 http 로 서빙해 5회 측정, 표준편차는 ms', { skip: reason ?? false }, async () => {
  const dist = await mkdtemp(join(tmpdir(), 'ff-'));
  await mkdir(join(dist, 'res/static'), { recursive: true });
  await writeFile(join(dist, 'res/static/status.html'),
    '<!doctype html><canvas id=status-view width=100 height=100></canvas><script>const g=document.getElementById("status-view").getContext("2d");g.fillStyle="#000";g.fillRect(0,0,100,100);setTimeout(()=>{g.fillStyle="#fff";g.fillRect(0,0,60,60)},500)</script>');
  const recs = await run({ outDir: join(dist, 'out'), commit: 'abcdef1', inputs: { distDir: dist }, timeoutMs: 10000 });
  assertRecords(recs);
  assert.deepEqual(recs.map((r) => r.metric), ['first_frame.median', 'first_frame.stddev']);
  assert.deepEqual(recs.map((r) => r.unit), ['ms', 'ms']);
  assert.equal(recs[0].device, DEVICE);
  const [med, sd] = recs;
  assert.equal(med.samples.length, RUNS);
  assert.ok(med.samples.every((x) => x >= 500), `samples ${med.samples}`);
  assert.equal(med.value, median(med.samples));
  assert.equal(sd.value, stddev(sd.samples));
});

test('run: entryPath 파일이 dist 에 없으면 throw(랜딩 index.html 만 있어도)', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'ff-'));
  await writeFile(join(dist, 'index.html'), '<p>landing</p>');
  await assert.rejects(() => run({ commit: 'abcdef1', inputs: { distDir: dist } }), /entryPath.*\/res\/static\/status\.html/);
  await assert.rejects(() => run({ commit: 'abcdef1', inputs: { distDir: dist, entryPath: 'res/x.html' } }), /entryPath/);
});

test('run: 기본 entryPath 는 method 에 명시되고 inputs.entryPath 로 바꿀 수 있다', { skip: reason ?? false }, async () => {
  const dist = await mkdtemp(join(tmpdir(), 'ff-'));
  await writeFile(join(dist, 'index.html'), '<canvas id=status-view width=100 height=100></canvas><script>const g=document.getElementById("status-view").getContext("2d");g.fillStyle="#000";g.fillRect(0,0,100,100);g.fillStyle="#fff";g.fillRect(0,0,60,60)</script>');
  const recs = await run({ commit: 'abcdef1', inputs: { distDir: dist, entryPath: '/index.html' }, runs: 2, timeoutMs: 10000 });
  assert.match(recs[0].method, /\/index\.html/);
  assert.match(recs[0].method, /스트림 재생은 범위 밖/);
});

// 실제 skylens dist 로 도는 선택적 테스트. SKYLENS_DIR 가 있을 때만 실행한다.
test('실제 dist(SKYLENS_DIR/dist): 상황판 첫 프레임이 30 s 안에 감지된다', { skip: process.env.SKYLENS_DIR ? (reason ?? false) : 'SKYLENS_DIR 없음' }, async () => {
  const recs = await run({ commit: 'abcdef1', inputs: { distDir: join(process.env.SKYLENS_DIR, 'dist') }, runs: 2, timeoutMs: 30000 });
  assert.ok(recs[0].value > 0 && recs[0].value < 30000, `median ${recs[0].value}`);
  assert.match(recs[0].method, /\/res\/static\/status\.html/);
});

test('canvasSelector: 기본값은 상황판 3D 캔버스, 빈 값은 거부', () => {
  assert.equal(resolveCanvasSelector({}), '#status-view');
  assert.equal(resolveCanvasSelector({ canvasSelector: '#control-view' }), '#control-view');
  assert.equal(resolveCanvasSelector({ canvasSelector: '#gl' }), '#gl');
  assert.throws(() => resolveCanvasSelector({ canvasSelector: '  ' }), /canvasSelector/);
});

async function distWith(html) {
  const dist = await mkdtemp(join(tmpdir(), 'ff-'));
  await mkdir(join(dist, 'res/static'), { recursive: true });
  await writeFile(join(dist, 'res/static/status.html'), html);
  return dist;
}
const MINIMAP = '<canvas id=mini class=minimap__canvas width=100 height=100></canvas><script>const m=mini.getContext("2d");m.fillStyle="#000";m.fillRect(0,0,100,100);m.fillStyle="#fff";m.fillRect(0,0,60,60)</script>';

test('2D 캔버스만 그리는 페이지(3D 캔버스는 비어 있음)는 미감지로 throw', { skip: reason ?? false }, async () => {
  const dist = await distWith('<canvas id=status-view width=100 height=100></canvas>' + MINIMAP);
  await assert.rejects(() => run({ commit: 'abcdef1', inputs: { distDir: dist }, runs: 1, timeoutMs: 2000 }), /첫 프레임 미감지/);
});

test('3D 캔버스가 500 ms 뒤 그려지면 미니맵이 먼저 그려져도 500 ms 이상이고 method 에 판정 캔버스가 기록된다', { skip: reason ?? false }, async () => {
  const dist = await distWith('<canvas id=status-view width=100 height=100></canvas>' + MINIMAP
    + '<script>const g=document.getElementById("status-view").getContext("2d");g.fillStyle="#000";g.fillRect(0,0,100,100);setTimeout(()=>{g.fillStyle="#fff";g.fillRect(0,0,60,60)},500)</script>');
  const recs = await run({ commit: 'abcdef1', inputs: { distDir: dist }, runs: 2, timeoutMs: 10000 });
  assert.ok(recs[0].samples.every((x) => x >= 500), `samples ${recs[0].samples}`);
  assert.match(recs[0].method, /#status-view/);
  assert.match(recs[0].method, /canvas#status-view/);
});

test('inputs.canvasSelector 로 판정 캔버스를 바꿀 수 있다', { skip: reason ?? false }, async () => {
  const dist = await distWith('<canvas id=status-view width=100 height=100></canvas>' + MINIMAP);
  const recs = await run({ commit: 'abcdef1', inputs: { distDir: dist, canvasSelector: 'canvas.minimap__canvas' }, runs: 1, timeoutMs: 5000 });
  assert.match(recs[0].method, /canvas\.minimap__canvas/);
  assert.match(recs[0].method, /canvas#mini\.minimap__canvas/);
});

test('선택 입력 키 이름이 틀리면(entrypath, canvasselector, canvasSelecter) 거부', async () => {
  assert.throws(() => resolveCanvasSelector({ canvasselector: '#a' }), /알 수 없는 inputs 키/);
  assert.throws(() => resolveCanvasSelector({ canvasSelecter: '#a' }), /canvasSelector/);
  await assert.rejects(() => run({ commit: 'abcdef1', inputs: { distDir: '/x', entrypath: '/a.html' } }), /entryPath/);
});
