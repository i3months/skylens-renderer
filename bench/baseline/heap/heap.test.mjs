import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { median, run, unavailableReason } from './index.mjs';

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

const reason = await unavailableReason();

test('브라우저: 약 10 MB 배열을 잡는 페이지의 중앙값 >= 10 MB', { skip: reason ?? false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heap-'));
  const file = join(dir, 'p.html');
  // 배열은 V8 힙에 올라간다(TypedArray 는 힙 밖이라 제외). 실수 1,400,000 개 = 약 10.7 MiB.
  writeFileSync(
    file,
    '<!doctype html><script>window.keep=new Array(1400000).fill(1.5);</script>',
  );
  const recs = await run({ skylensDir: dir, outDir: dir, commit: 'abcdef1', url: pathToFileURL(file).href, settleMs: 300 });
  assertRecords(recs);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].metric, 'heap.js_used_median');
  assert.equal(recs[0].unit, 'B');
  assert.equal(recs[0].samples.length, 5);
  assert.ok(recs[0].value >= 10 * 1024 * 1024, `median ${recs[0].value}`);
});
