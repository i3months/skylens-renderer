import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { median, stddev, run, RUNS } from './index.mjs';
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
    '<!doctype html><canvas id=c width=100 height=100></canvas><script>const g=c.getContext("2d");g.fillStyle="#000";g.fillRect(0,0,100,100);setTimeout(()=>{g.fillStyle="#fff";g.fillRect(0,0,60,60)},500)</script>');
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
  await writeFile(join(dist, 'index.html'), '<canvas id=c width=100 height=100></canvas><script>const g=c.getContext("2d");g.fillStyle="#000";g.fillRect(0,0,100,100);g.fillStyle="#fff";g.fillRect(0,0,60,60)</script>');
  const recs = await run({ commit: 'abcdef1', inputs: { distDir: dist, entryPath: '/index.html' }, runs: 2, timeoutMs: 10000 });
  assert.match(recs[0].method, /\/index\.html/);
  assert.match(recs[0].method, /스트림 재생은 범위 밖/);
});

// 실제 skylens dist 로 도는 선택적 테스트. SKYLENS_DIST_DIR 가 있을 때만 실행한다.
test('실제 dist(SKYLENS_DIST_DIR): 상황판 첫 프레임이 30 s 안에 감지된다', { skip: process.env.SKYLENS_DIST_DIR ? (reason ?? false) : 'SKYLENS_DIST_DIR 없음' }, async () => {
  const recs = await run({ commit: 'abcdef1', inputs: { distDir: process.env.SKYLENS_DIST_DIR }, runs: 2, timeoutMs: 30000 });
  assert.ok(recs[0].value > 0 && recs[0].value < 30000, `median ${recs[0].value}`);
  assert.match(recs[0].method, /\/res\/static\/status\.html/);
});
