import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './index.mjs';

const skylensDir = process.env.SKYLENS_DIR;
const EXPECTED = [33134, 57728, 71136, 14957, 31975, 51731, 18633, 8799];
const hashes = (d) => Object.fromEntries(readdirSync(d).sort().map((f) => [f, createHash('sha256').update(readFileSync(join(d, f))).digest('hex')]));

test('ref_images_deterministic', { skip: !skylensDir && 'SKYLENS_DIR not set' }, async () => {
  const a = mkdtempSync(join(tmpdir(), 'ref-a-')), b = mkdtempSync(join(tmpdir(), 'ref-b-'));
  try {
    const ra = await run({ skylensDir, outDir: a, commit: '64012a0' });
    const rb = await run({ skylensDir, outDir: b, commit: '64012a0' });
    const ha = hashes(a);
    assert.equal(Object.keys(ha).length, 8);
    assert.deepEqual(ha, hashes(b));
    assert.deepEqual(ra, rb);
    assert.deepEqual(ra.map((r) => r.value), EXPECTED);
    ra.forEach((r, i) => assert.equal(r.metric, `ref.view${i + 1}.nonempty_px`));
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});
