import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { median, variance, run, findChromium, RUNS } from './index.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

test('median: 기준 숫자', () => {
  assert.equal(median([1, 2, 3, 4, 100]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.throws(() => median([]));
});

test('variance: 기준 숫자(표본 분산)', () => {
  assert.equal(variance([1, 2, 3, 4, 5]), 2.5);
  assert.equal(variance([5, 5, 5]), 0);
  assert.equal(variance([3]), 0);
  assert.ok(Math.abs(variance([2, 4, 4, 4, 5, 5, 7, 9]) - 32 / 7) < 1e-12);
  assert.throws(() => variance([]));
});

const exe = await findChromium();

test('합성 페이지 5회 측정', { skip: exe ? false : 'Chromium 이 PLAYWRIGHT_BROWSERS_PATH(/opt/pw-browsers)에 없어 브라우저 테스트를 건너뜀' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'));
  await mkdir(join(dir, 'dist'));
  await writeFile(join(dir, 'dist', 'index.html'),
    '<!doctype html><html><body><script>requestAnimationFrame(()=>{window.__firstFrame=true;document.body.dataset.ffMs=performance.now()});</script></body></html>');
  const recs = await run({ skylensDir: dir, outDir: join(dir, 'out'), commit: 'abcdef1' });
  assertRecords(recs);
  const med = recs.find((r) => r.metric === 'first_frame.median');
  const vr = recs.find((r) => r.metric === 'first_frame.variance_sq');
  assert.equal(med.samples.length, RUNS);
  assert.ok(med.samples.every((x) => x > 0));
  assert.equal(med.value, median(med.samples));
  assert.equal(vr.value, variance(vr.samples));
});
