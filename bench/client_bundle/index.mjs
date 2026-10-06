import { pathToFileURL } from 'node:url';
import { measureBundle } from '../tower/bundle.mjs';

const modules = [
  'client/proto',
  'client/codec',
  'client/asset',
  'client/levels',
  'client/cull',
  'client/geo'
];

async function main() {
  // Entries are bundled together (shared chunks counted once); esbuild is
  // required and a failure throws, there is no fallback.
  const { entries, chunks, totalGzip, totalMinified } = await measureBundle(modules);
  const results = entries.map((e) => ({
    module: e.module,
    raw: e.minified,
    gzip: e.gzip,
    method: 'esbuild'
  }));
  for (const c of chunks) {
    results.push({ module: `(shared) ${c.file}`, raw: c.minified, gzip: c.gzip, method: 'esbuild' });
  }

  console.log('\nClient Bundle Sizes:');
  console.log('='.repeat(70));
  console.log('Module'.padEnd(30) + 'Raw'.padStart(12) + 'Gzip'.padStart(12) + 'Method'.padStart(16));
  console.log('-'.repeat(70));
  for (const r of results) {
    console.log(
      r.module.padEnd(30) +
      String(r.raw).padStart(12) +
      String(r.gzip).padStart(12) +
      r.method.padStart(16)
    );
  }
  console.log('-'.repeat(70));
  console.log('Total'.padEnd(30) + String(totalMinified).padStart(12) + String(totalGzip).padStart(12));
  console.log('='.repeat(70));
  console.log(`Total gzip size: ${totalGzip} bytes (${(totalGzip / 1024).toFixed(2)} KB)`);

  return results;
}

export { main, modules };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
