import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { resolve } from 'path';

const GZIP_LIMIT_BYTES = 300 * 1024;
const modules = [
  'client/proto',
  'client/codec',
  'client/asset',
  'client/levels',
  'client/cull',
  'client/geo'
];

async function checkEsbuild() {
  try {
    const nodeModulesPath = resolve('./node_modules/.bin/esbuild');
    try {
      execSync(`${nodeModulesPath} --version`, { stdio: 'ignore' });
      return { available: true, command: nodeModulesPath };
    } catch {
      try {
        execSync('npx esbuild --version', { stdio: 'ignore' });
        return { available: true, command: 'npx esbuild' };
      } catch {
        return { available: false };
      }
    }
  } catch {
    return { available: false };
  }
}

async function bundleWithEsbuild(modulePath, esbuildCmd) {
  const entryPath = resolve(modulePath, 'index.mjs');
  const outputPath = `/tmp/bundle-test-${modulePath.replace(/\//g, '-')}.mjs`;

  try {
    const cmd = `${esbuildCmd} ${entryPath} --bundle --minify --format=esm --outfile=${outputPath}`;
    execSync(cmd, { stdio: 'ignore' });
    return readFileSync(outputPath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to bundle ${modulePath}: ${error.message}`);
  }
}

function concatenateSources(modulePath) {
  const entryPath = resolve(modulePath, 'index.mjs');
  try {
    return readFileSync(entryPath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read ${modulePath}: ${error.message}`);
  }
}

function measureGzipSize(content) {
  const gzipped = gzipSync(content, { level: 9 });
  return gzipped.length;
}

test('client bundle gzip size', async (t) => {
  const esbuild = await checkEsbuild();

  if (!esbuild.available) {
    // Skip if esbuild is not available and no network
    t.skip('esbuild not available, skipping bundle test');
    return;
  }

  let totalSize = 0;

  for (const modulePath of modules) {
    let content;

    try {
      content = await bundleWithEsbuild(modulePath, esbuild.command);
    } catch (error) {
      t.fail(`Failed to bundle ${modulePath}: ${error.message}`);
      return;
    }

    const gzipSize = measureGzipSize(content);
    totalSize += gzipSize;
  }

  assert.ok(
    totalSize <= GZIP_LIMIT_BYTES,
    `Total gzip size ${totalSize} bytes exceeds limit of ${GZIP_LIMIT_BYTES} bytes (${(totalSize / 1024).toFixed(2)} KB / ${GZIP_LIMIT_BYTES / 1024} KB)`
  );
});
