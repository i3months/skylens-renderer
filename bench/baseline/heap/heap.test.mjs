import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRecords, parse } from '../../../contracts/metrics/index.mjs';
import { run } from './index.mjs';

const SKYLENS_DIR = process.env.SKYLENS_DIR;

test('heap_status_js_bytes', { skip: !SKYLENS_DIR && 'SKYLENS_DIR not set', timeout: 900_000 }, async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'heap-out-'));
  const recs = await run({ skylensDir: SKYLENS_DIR, outDir, commit: '59edcf9' });
  assertRecords(recs);
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.metric, 'heap.status.js_bytes');
  assert.equal(r.unit, 'B');
  assert.equal(r.samples.length, 5);
  assert.ok(r.value > 1e6 && r.samples.every((x) => x > 0));
  assert.deepEqual(parse(readFileSync(join(outDir, 'heap.json'), 'utf8')), recs);
});
