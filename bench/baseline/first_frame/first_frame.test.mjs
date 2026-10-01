import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { run, METRIC, RUNS, median, variance } from './index.mjs';

const skylensDir = process.env.SKYLENS_DIR;

test('median/variance helpers', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(variance([1, 3]), 2);
});

test('status first-frame record is valid with 5 samples', { skip: !skylensDir && 'SKYLENS_DIR not set', timeout: 900_000 }, async () => {
  const commit = execFileSync('git', ['-C', skylensDir, 'rev-parse', 'HEAD']).toString().trim();
  const outDir = mkdtempSync(path.join(tmpdir(), 'first-frame-'));
  const recs = assertRecords(await run({ skylensDir, outDir, commit }));
  assert.equal(recs.length, 1);
  const [r] = recs;
  assert.equal(r.metric, METRIC);
  assert.equal(r.unit, 'ms');
  assert.ok(r.value > 0);
  assert.equal(r.samples.length, RUNS);
  assert.equal(RUNS, 5);
  assert.ok(r.samples.every((x) => x > 0));
  assert.equal(r.value, median(r.samples));
  const detail = JSON.parse(readFileSync(path.join(outDir, 'first_frame.detail.json'), 'utf8'));
  assert.ok(detail.variance >= 0);
  assert.ok(detail.litFraction.every((f) => f > 0.02), 'splat should be visible in every run');
});
