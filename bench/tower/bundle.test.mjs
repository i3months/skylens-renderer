import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureBundle, reachableInputs, modules } from './bundle.mjs';
import { CONTROLVIEW_LIMITS } from '../../contracts/controlview/index.mjs';

const LIMIT = CONTROLVIEW_LIMITS.bundleBytes;
const EXPECTED_MODULES = [
  'client/tower/input', 'client/tower/chase', 'client/tower/overlay',
  'client/tower/streaming', 'client/tower/fallback', 'client/tower/e2e',
  'client/tower/terrain', 'client/tower/buildings', 'client/tower/drape',
  'client/raster',
];
const MIN_ENTRY_GZIP = 50; // an entry that bundles to fewer bytes is empty/broken
// Floor for the whole bundle. Measured with only the entry files counted
// (bundle:false, shared chunks dropped, or every import external) the total is
// ~16,280 B; the real graph is 68,062 B. 32,000 B is about twice the
// entry-files-only value, so any measurement that stops following imports
// falls below it, while it stays well under the real total so ordinary
// refactors do not trip it.
const MIN_TOTAL_GZIP = 32_000;
// Shared chunks alone. Measured on the real graph: 13 chunks, 32,630 B gzip
// (entries alone: 35,432 B). 16,000 B is about half of that, so a measurement
// that keeps only some of the chunks (e.g. one) falls well below it, while
// ordinary refactors that move code between chunks do not trip it.
const MIN_CHUNK_GZIP = 16_000;
// Number of shared chunks. Measured on the real graph: 13. Keeping only the
// few large chunks (and adjusting outputs to match) still passes the gzip
// floor above, so the count is checked too. 10 leaves a margin of 3 for
// chunks merging in ordinary refactors while rejecting a handful of survivors.
const MIN_CHUNK_COUNT = 10;
// e2e wires the other tower modules together; its graph must include them.
const MIN_E2E_INPUTS = 10;

// esbuild is a pinned devDependency; if it is missing the measurement throws
// and these tests fail (no fallback measurement exists).
test('tower client bundle gzip size <= CONTROLVIEW_LIMITS.bundleBytes', { timeout: 120_000 }, async () => {
  assert.deepEqual(modules, EXPECTED_MODULES, 'module list must not shrink');
  const r = await measureBundle(modules);

  console.log('\nActual tower bundle measurements (entries bundled together, shared chunks once):');
  for (const e of r.entries) console.log(`  ${e.module}: ${e.gzip} gzip bytes`);
  for (const c of r.chunks) console.log(`  (shared) ${c.file}: ${c.gzip} gzip bytes`);
  console.log(`  Total: ${r.totalGzip} bytes; limit ${LIMIT} bytes`);

  assert.equal(typeof LIMIT, 'number');
  assert.equal(LIMIT, 300_000);

  // negative assertions: the measurement actually measured everything
  assert.equal(r.entries.length, modules.length, 'one measured entry per module');
  assert.deepEqual(r.entries.map((e) => e.module), modules);
  for (const e of r.entries) {
    assert.ok(e.minified > 0, `${e.module} minified size must be > 0`);
    assert.ok(e.gzip >= MIN_ENTRY_GZIP, `${e.module} gzip ${e.gzip} below floor ${MIN_ENTRY_GZIP}`);
  }
  const sum = [...r.entries, ...r.chunks].reduce((s, x) => s + x.gzip, 0);
  assert.equal(r.totalGzip, sum, 'total equals sum of emitted files');
  // every entry's bundled import graph spans more than its own index file
  for (const e of r.entries) {
    assert.ok(e.inputs > 1, `${e.module} bundles ${e.inputs} source file(s); imports were not followed`);
  }
  const e2e = r.entries.find((e) => e.module === 'client/tower/e2e');
  assert.ok(e2e.inputs >= MIN_E2E_INPUTS, `e2e bundles ${e2e.inputs} files, expected >= ${MIN_E2E_INPUTS}`);
  // code shared between entries must be emitted and counted, not dropped
  assert.ok(r.chunks.length >= 1, 'shared chunks must be emitted and counted');
  // metafile.outputs is the independent count of emitted files; the rows
  // returned must account for every one of them (a dropped chunk breaks this)
  assert.ok(Number.isInteger(r.outputs) && r.outputs > 0, `outputs must be a positive integer, got ${r.outputs}`);
  assert.equal(r.entries.length + r.chunks.length, r.outputs, 'emit count = entries + chunks (no emitted file left unmeasured)');
  const chunkGzip = r.chunks.reduce((s, x) => s + x.gzip, 0);
  assert.ok(chunkGzip >= MIN_CHUNK_GZIP, `shared chunks gzip ${chunkGzip} below floor ${MIN_CHUNK_GZIP}`);
  assert.ok(r.chunks.length >= MIN_CHUNK_COUNT, `shared chunk count ${r.chunks.length} below floor ${MIN_CHUNK_COUNT}`);
  const entriesOnly = r.entries.reduce((s, x) => s + x.gzip, 0);
  assert.ok(r.totalGzip > entriesOnly, 'total must exceed the entry files alone');
  assert.ok(r.totalGzip >= MIN_TOTAL_GZIP, `total gzip ${r.totalGzip} below floor ${MIN_TOTAL_GZIP}`);

  assert.ok(r.totalGzip <= LIMIT, `Total gzip size ${r.totalGzip} bytes exceeds limit of ${LIMIT} bytes`);
});

test('positive control: a small entry importing a large module is judged over the limit', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bundle-control-'));
  try {
    mkdirSync(join(root, 'big'));
    // incompressible payload well above the limit, living in a separate module
    const payload = randomBytes(Math.ceil(LIMIT * 1.5)).toString('base64');
    writeFileSync(join(root, 'big', 'payload.mjs'), `export const blob = ${JSON.stringify(payload)};\n`);
    writeFileSync(join(root, 'big', 'index.mjs'), `import { blob } from './payload.mjs';\nexport const len = blob.length;\n`);
    const r = await measureBundle(['big'], { root });
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].inputs, 2, 'entry graph must include the imported module');
    assert.ok(r.totalGzip > LIMIT, `control gzip ${r.totalGzip} should exceed ${LIMIT}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('guard: reachableInputs throws for an entry that is not a metafile.inputs key', () => {
  const metafile = { inputs: { 'a.mjs': { imports: [] } } };
  assert.equal(reachableInputs(metafile, 'a.mjs'), 1);
  assert.throws(() => reachableInputs(metafile, 'missing.mjs'), /not found in metafile\.inputs/);
});

test('guard: measureBundle rejects an empty or non-array entry list', async () => {
  await assert.rejects(() => measureBundle([]), /at least one entry module/);
  await assert.rejects(() => measureBundle('client/raster'), /at least one entry module/);
});
