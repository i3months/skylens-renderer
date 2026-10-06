import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { measureBundle } from '../tower/bundle.mjs';
import { CONTROLVIEW_LIMITS } from '../../contracts/controlview/index.mjs';
import { modules } from './index.mjs';

// Limit comes from the contract; measurement is the shared esbuild-based one
// (no npx fallback: esbuild is a devDependency installed by "npm ci").
const GZIP_LIMIT_BYTES = CONTROLVIEW_LIMITS.bundleBytes;

test('client bundle gzip size', { timeout: 60_000 }, async () => {
  const { totalGzip } = await measureBundle(modules);
  assert.ok(totalGzip > 0, 'measured size must be positive');
  assert.ok(
    totalGzip <= GZIP_LIMIT_BYTES,
    `Total gzip size ${totalGzip} bytes exceeds limit of ${GZIP_LIMIT_BYTES} bytes`
  );
});
