import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { gzipSync } from 'zlib';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { main, modules } from './bundle.mjs';

const GZIP_LIMIT_BYTES = 300 * 1024;

async function checkEsbuild() {
  try {
    const nodeModulesPath = resolve('./node_modules/.bin/esbuild');
    try {
      execSync(`${nodeModulesPath} --version`, { stdio: 'ignore', timeout: 20000 });
      return { available: true, command: nodeModulesPath };
    } catch {
      try {
        execSync('npx esbuild --version', { stdio: 'ignore', timeout: 20000 });
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
  const tempDir = mkdtempSync(resolve(tmpdir(), 'bundle-test-'));
  const outputPath = resolve(tempDir, `${modulePath.replace(/\//g, '-')}.mjs`);

  try {
    const cmd = `${esbuildCmd} ${entryPath} --bundle --minify --format=esm --outfile=${outputPath}`;
    execSync(cmd, { stdio: 'ignore', timeout: 20000 });
    const content = readFileSync(outputPath, 'utf8');
    rmSync(tempDir, { recursive: true, force: true });
    return content;
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
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

test('tower client bundle gzip size <= 300 KB', { timeout: 60_000 }, async (t) => {
  const esbuild = await checkEsbuild();

  let totalSize = 0;
  const moduleSizes = [];

  for (const modulePath of modules) {
    let content;

    if (esbuild.available) {
      try {
        content = await bundleWithEsbuild(modulePath, esbuild.command);
      } catch (error) {
        assert.fail(`Failed to bundle ${modulePath}: ${error.message}`);
      }
    } else {
      content = concatenateSources(modulePath);
    }

    const gzipSize = measureGzipSize(content);
    totalSize += gzipSize;
    moduleSizes.push({ module: modulePath, gzip: gzipSize });
  }

  // Log actual measurement values
  console.log('\nActual tower bundle measurements:');
  for (const { module, gzip } of moduleSizes) {
    console.log(`  ${module}: ${gzip} bytes (${(gzip / 1024).toFixed(2)} KB)`);
  }
  console.log(`  Total: ${totalSize} bytes (${(totalSize / 1024).toFixed(2)} KB)`);
  console.log(`  Limit: ${GZIP_LIMIT_BYTES} bytes (${GZIP_LIMIT_BYTES / 1024} KB)`);

  assert.ok(
    totalSize <= GZIP_LIMIT_BYTES,
    `Total gzip size ${totalSize} bytes exceeds limit of ${GZIP_LIMIT_BYTES} bytes (${(totalSize / 1024).toFixed(2)} KB / ${GZIP_LIMIT_BYTES / 1024} KB)`
  );
});
