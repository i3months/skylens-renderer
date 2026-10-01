import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './index.mjs';
import { serialize } from '../../../contracts/metrics/index.mjs';

const skylensDir = process.env.SKYLENS_DIR;
const commit = process.env.SKYLENS_COMMIT || '59edcf9b38b0887cb63dcaa2daa07a123f81dd95';

test('bundle_status is deterministic', { skip: !skylensDir && 'SKYLENS_DIR not set' }, async () => {
  const a = await run({ skylensDir, outDir: mkdtempSync(join(tmpdir(), 'bs-')), commit });
  const b = await run({ skylensDir, outDir: mkdtempSync(join(tmpdir(), 'bs-')), commit });
  assert.equal(serialize(a), serialize(b));
  const gz = a.find((r) => r.metric === 'bundle.status.gzip');
  const raw = a.find((r) => r.metric === 'bundle.status.raw');
  assert.ok(gz.value > 0 && gz.value < raw.value);
});
