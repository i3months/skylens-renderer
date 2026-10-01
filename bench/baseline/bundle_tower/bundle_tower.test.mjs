import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize } from '../../../contracts/metrics/index.mjs';
import { run } from './index.mjs';

const skylensDir = process.env.SKYLENS_DIR;
const commit = '59edcf9b38b0887cb63dcaa2daa07a123f81dd95';

test('bundle_tower_deterministic', { skip: !skylensDir && 'SKYLENS_DIR not set' }, async () => {
  const a = await run({ skylensDir, outDir: mkdtempSync(join(tmpdir(), 'bt-')), commit });
  const b = await run({ skylensDir, outDir: mkdtempSync(join(tmpdir(), 'bt-')), commit });
  assert.equal(serialize(a), serialize(b));
  const g = a.find((r) => r.metric === 'bundle.tower.gzip');
  assert.ok(g && g.unit === 'B' && g.value > 100000);
});
