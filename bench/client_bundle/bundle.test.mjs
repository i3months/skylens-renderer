import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { measureBundle } from '../tower/bundle.mjs';
import { CONTROLVIEW_LIMITS } from '../../contracts/controlview/index.mjs';
import { modules } from './index.mjs';

// Limit comes from the contract; measurement is the shared esbuild-based one
// (no npx fallback: esbuild is a devDependency installed by "npm ci").
const GZIP_LIMIT_BYTES = CONTROLVIEW_LIMITS.bundleBytes;

const EXPECTED_MODULES = [
  'client/proto', 'client/codec', 'client/asset',
  'client/levels', 'client/cull', 'client/geo',
];
// Source files in each entry's bundled import graph, measured on the real
// graph (proto 4, codec 5, asset 3, levels 4, cull 1, geo 2; sum 19). Used as
// lower bounds: an unfollowed import (bundle:false, external) drops them to 1.
const MIN_INPUTS = {
  'client/proto': 4, 'client/codec': 5, 'client/asset': 3,
  'client/levels': 4, 'client/cull': 1, 'client/geo': 2,
};
const MIN_TOTAL_INPUTS = 19;
// Measured: total 12,411 B gzip = entries 10,268 + 2 shared chunks 2,143.
// Floors are about half of the measured values so that a measurement that
// stops following imports or drops chunks falls below them, while ordinary
// refactors do not trip them.
const MIN_TOTAL_GZIP = 6_000;
const MIN_CHUNK_GZIP = 1_000;

test('client bundle gzip size', { timeout: 60_000 }, async () => {
  assert.deepEqual(modules, EXPECTED_MODULES, 'module list must not shrink');
  const r = await measureBundle(modules);
  assert.ok(r.totalGzip > 0, 'measured size must be positive');

  // negative assertions: the measurement actually measured everything
  assert.equal(r.entries.length, modules.length, 'one measured entry per module');
  assert.deepEqual(r.entries.map((e) => e.module), modules);
  for (const e of r.entries) {
    assert.ok(e.minified > 0 && e.gzip > 0, `${e.module} must have nonzero size`);
    assert.ok(e.inputs >= MIN_INPUTS[e.module], `${e.module} bundles ${e.inputs} source file(s), expected >= ${MIN_INPUTS[e.module]}; imports were not followed`);
  }
  assert.ok(r.entries.reduce((s, e) => s + e.inputs, 0) >= MIN_TOTAL_INPUTS, 'total bundled source files below floor');
  assert.ok(r.chunks.length >= 1, 'shared chunks must be emitted and counted');
  assert.ok(Number.isInteger(r.outputs), `outputs must be an integer, got ${r.outputs}`);
  assert.equal(r.entries.length + r.chunks.length, r.outputs, 'emit count = entries + chunks (no emitted file left unmeasured)');
  const chunkGzip = r.chunks.reduce((s, x) => s + x.gzip, 0);
  assert.ok(chunkGzip >= MIN_CHUNK_GZIP, `shared chunks gzip ${chunkGzip} below floor ${MIN_CHUNK_GZIP}`);
  const sum = [...r.entries, ...r.chunks].reduce((s, x) => s + x.gzip, 0);
  assert.equal(r.totalGzip, sum, 'total equals sum of emitted files');
  assert.ok(r.totalGzip >= MIN_TOTAL_GZIP, `total gzip ${r.totalGzip} below floor ${MIN_TOTAL_GZIP}`);

  assert.ok(
    r.totalGzip <= GZIP_LIMIT_BYTES,
    `Total gzip size ${r.totalGzip} bytes exceeds limit of ${GZIP_LIMIT_BYTES} bytes`
  );
});
