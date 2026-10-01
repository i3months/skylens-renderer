import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { median, run } from './index.mjs';
import { unavailableReason, DEVICE } from '../_common/browser.mjs';

test('median: 기준 숫자', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.equal(median([9, 1, 5, 100, 2]), 5);
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]); // 입력 불변
  assert.throws(() => median([]));
});

test('run: inputs.distDir 없으면 throw', async () => {
  await assert.rejects(() => run({ commit: 'abcdef1', inputs: {} }), /input missing: distDir/);
});

const reason = await unavailableReason();
if (reason) console.log(`# 브라우저 테스트 skip 사유: ${reason}`);

const MIB = 1024 * 1024;
// 100 MiB Float32Array(26214400 개)를 채워 실제로 상주시킨 뒤 캔버스를 그려 첫 프레임을 낸다.
const HOLD = '<!doctype html><canvas id=c width=100 height=100></canvas><script>window.keep=new Float32Array(26214400).fill(1.5);const g=c.getContext("2d");g.fillStyle="#000";g.fillRect(0,0,100,100);g.fillStyle="#fff";g.fillRect(0,0,50,50)</script>';
const BLANK = HOLD.replace('new Float32Array(26214400).fill(1.5)', '[]');

async function measure(html) {
  const dist = await mkdtemp(join(tmpdir(), 'heap-'));
  await writeFile(join(dist, 'index.html'), html);
  const recs = await run({ commit: 'abcdef1', inputs: { distDir: dist }, runs: 3, timeoutMs: 15000 });
  assertRecords(recs);
  return Object.fromEntries(recs.map((r) => [r.metric, r]));
}

test('브라우저: 100 MiB Float32Array 픽스처의 프로세스 메모리 >= 100 MiB, JS 힙은 힙 밖이라 작다', { skip: reason ?? false }, async () => {
  const hold = await measure(HOLD);
  const blank = await measure(BLANK);
  assert.deepEqual(Object.keys(hold).sort(), ['heap.js_used', 'heap.process_rss']);
  assert.equal(hold['heap.js_used'].unit, 'B');
  assert.equal(hold['heap.js_used'].device, DEVICE);
  assert.equal(hold['heap.js_used'].samples.length, 3);
  assert.ok(hold['heap.process_rss'].value >= 100 * MIB, `rss ${hold['heap.process_rss'].value}`);
  // 같은 브라우저의 빈 페이지 대비 증가분이 50 MiB 이상이어야 한다(프로세스 기저 메모리 편차가 커 느슨한 보조 확인).
  assert.ok(hold['heap.process_rss'].value - blank['heap.process_rss'].value >= 50 * MIB,
    `delta ${hold['heap.process_rss'].value - blank['heap.process_rss'].value}`);
  // TypedArray 는 V8 힙 밖이므로 js_used 는 50 MiB 미만.
  assert.ok(hold['heap.js_used'].value < 50 * MIB, `js ${hold['heap.js_used'].value}`);
});
