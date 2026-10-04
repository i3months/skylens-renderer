import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { gzipSync } from 'zlib';
import { resolve } from 'path';

import { tmpdir } from 'os';
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
      execSync(`${nodeModulesPath} --version`, { stdio: 'ignore', timeout: 20000 });
      return { available: true, command: nodeModulesPath, source: 'node_modules' };
    } catch {
      // Fall back to npx
      try {
        execSync('npx esbuild --version', { stdio: 'ignore', timeout: 20000 });
        return { available: true, command: 'npx esbuild', source: 'npx' };
      } catch {
        return { available: false, source: null };
      }
    }
  } catch {
    return { available: false, source: null };
  }
}

async function bundleWithEsbuild(modulePath, esbuildCmd) {
  const entryPath = resolve(modulePath, 'index.mjs');
  const tempDir = mkdtempSync(resolve(tmpdir(), 'bundle-'));
  const outputPath = resolve(tempDir, `${modulePath.replace(/\//g, '-')}.mjs`);

  try {
    const cmd = `${esbuildCmd} ${entryPath} --bundle --minify --format=esm --outfile=${outputPath}`;
    execSync(cmd, { stdio: 'ignore', timeout: 20000 });
    const result = readFileSync(outputPath, 'utf8');
    rmSync(tempDir, { recursive: true, force: true });
    return result;
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

async function generateTable(esbuild) {
  const results = [];
  let totalSize = 0;

  for (const modulePath of modules) {
    let content;
    let method;

    if (esbuild.available) {
      try {
        content = await bundleWithEsbuild(modulePath, esbuild.command);
        method = `esbuild (${esbuild.source})`;
      } catch (error) {
        console.error(`Error bundling ${modulePath}:`, error.message);
        process.exit(1);
      }
    } else {
      content = concatenateSources(modulePath);
      method = 'concatenate (fallback)';
    }

    const gzipSize = measureGzipSize(content);
    totalSize += gzipSize;

    results.push({
      module: modulePath,
      raw: content.length,
      gzip: gzipSize,
      method: method
    });
  }

  return { results, totalSize };
}

async function main() {
  const esbuild = await checkEsbuild();

  if (!esbuild.available) {
    console.log('esbuild not available, using concatenating size estimator');
  }

  const { results, totalSize } = await generateTable(esbuild);

  // Print table
  console.log('\nClient Bundle Sizes:');
  console.log('='.repeat(70));
  console.log('Module'.padEnd(20) + 'Raw'.padStart(12) + 'Gzip'.padStart(12) + 'Method'.padStart(26));
  console.log('-'.repeat(70));

  for (const result of results) {
    console.log(
      result.module.padEnd(20) +
      result.raw.toString().padStart(12) +
      result.gzip.toString().padStart(12) +
      result.method.padStart(26)
    );
  }

  console.log('-'.repeat(70));
  console.log('Total'.padEnd(20) + ''.padStart(12) + totalSize.toString().padStart(12));
  console.log('='.repeat(70));
  console.log(`Total gzip size: ${totalSize} bytes (${(totalSize / 1024).toFixed(2)} KB)`);

  return results;
}

export { main, modules };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
