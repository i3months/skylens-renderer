import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const ENTRY = 'src/skylens_client/statusview/statusViewer.ts';
const METHOD = 'esbuild bundle+minify (esm, es2022, NODE_ENV=production) of statusview entry with three and gaussian-splats-3d; node zlib gzip level 9';

export async function run({ skylensDir, outDir, commit }) {
  const req = createRequire(join(skylensDir, 'package.json'));
  const esbuild = req('esbuild');
  const result = await esbuild.build({
    absWorkingDir: skylensDir,
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    outfile: 'bundle.js',
  });
  const out = result.outputFiles.find((f) => f.path.endsWith('.js'));
  const bytes = Buffer.from(out.contents);
  const gz = gzipSync(bytes, { level: 9 });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'status.bundle.js'), bytes);
  writeFileSync(join(outDir, 'status.bundle.js.gz'), gz);
  const base = { unit: 'B', device: 'build', method: METHOD, commit };
  return assertRecords([
    { metric: 'bundle.status.gzip', value: gz.length, ...base },
    { metric: 'bundle.status.raw', value: bytes.length, ...base },
  ]);
}
