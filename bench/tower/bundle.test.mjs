import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureBundle, modules } from './bundle.mjs';
import { CONTROLVIEW_LIMITS } from '../../contracts/controlview/index.mjs';

const LIMIT = CONTROLVIEW_LIMITS.bundleBytes;
const EXPECTED_MODULES = [
  'client/tower/input', 'client/tower/chase', 'client/tower/overlay',
  'client/tower/streaming', 'client/tower/fallback', 'client/tower/e2e',
  'client/tower/terrain', 'client/tower/buildings', 'client/tower/drape',
  'client/raster',
];
const MIN_ENTRY_GZIP = 50; // an entry that bundles to fewer bytes is empty/broken
const MIN_TOTAL_GZIP_PER_MODULE = 1024;

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
  assert.ok(
    r.totalGzip >= modules.length * MIN_TOTAL_GZIP_PER_MODULE,
    `total gzip ${r.totalGzip} below floor ${modules.length * MIN_TOTAL_GZIP_PER_MODULE}`
  );

  assert.ok(r.totalGzip <= LIMIT, `Total gzip size ${r.totalGzip} bytes exceeds limit of ${LIMIT} bytes`);
});

test('positive control: a large input is judged over the limit', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bundle-control-'));
  try {
    mkdirSync(join(root, 'big'));
    // incompressible payload well above the limit
    const payload = randomBytes(Math.ceil(LIMIT * 1.5)).toString('base64');
    writeFileSync(join(root, 'big', 'index.mjs'), `export const blob = ${JSON.stringify(payload)};\n`);
    const r = await measureBundle(['big'], { root });
    assert.equal(r.entries.length, 1);
    assert.ok(r.totalGzip > LIMIT, `control gzip ${r.totalGzip} should exceed ${LIMIT}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
