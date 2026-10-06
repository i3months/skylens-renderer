import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, relative, sep } from 'node:path';

// Repo root resolved from this file, never from the current working directory.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Entry points (directories holding index.mjs). client/raster is included.
const modules = [
  'client/tower/input',
  'client/tower/chase',
  'client/tower/overlay',
  'client/tower/streaming',
  'client/tower/fallback',
  'client/tower/e2e',
  'client/tower/terrain',
  'client/tower/buildings',
  'client/tower/drape',
  'client/raster',
];

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch (error) {
    throw new Error(
      `esbuild is required (devDependency, run "npm ci"): ${error.message}`
    );
  }
}

function gzipBytes(bytes) {
  return gzipSync(bytes, { level: 9 }).length;
}

// Number of distinct source files bundled into an entry's import graph
// (esbuild metafile; external imports are not followed, so they do not count).
// Throws when entryInput is not a key of metafile.inputs (F-468 1).
function reachableInputs(metafile, entryInput) {
  if (!metafile.inputs[entryInput]) {
    throw new Error(`entry "${entryInput}" not found in metafile.inputs`);
  }
  const seen = new Set();
  const stack = [entryInput];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !metafile.inputs[f]) continue;
    seen.add(f);
    for (const imp of metafile.inputs[f].imports) if (!imp.external) stack.push(imp.path);
  }
  return seen.size;
}

/**
 * Bundle all entries together (code splitting, minified ESM) so modules shared
 * between entries are counted once, then gzip every emitted file.
 * Returns { entries, chunks, outputs, totalGzip, totalMinified }.
 *   outputs: number of emitted files (metafile.outputs)
 *   entries: one row per requested module, { module, minified, gzip, inputs }
 *            (inputs = source files in the entry's bundled import graph)
 *   chunks:  shared chunks emitted by splitting, { file, minified, gzip }
 * Throws when esbuild is missing or a bundle fails; never falls back.
 */
async function measureBundle(entryModules = modules, { root = ROOT, esbuild } = {}) {
  if (!Array.isArray(entryModules) || entryModules.length === 0) {
    throw new Error('measureBundle requires at least one entry module');
  }
  const es = esbuild ?? (await loadEsbuild());
  const entryPoints = {};
  for (const m of entryModules) entryPoints[m] = resolve(root, m, 'index.mjs');
  const outdir = resolve(root, '.bundle-measure-out');
  const result = await es.build({
    entryPoints,
    bundle: true,
    minify: true,
    format: 'esm',
    splitting: true,
    write: false,
    metafile: true,
    outdir,
    absWorkingDir: root,
    logLevel: 'silent',
  });
  // Map each emitted file to its entry source via metafile.outputs[].entryPoint.
  const entryOf = new Map();
  for (const [outPath, meta] of Object.entries(result.metafile.outputs)) {
    if (meta.entryPoint) entryOf.set(resolve(root, outPath), meta.entryPoint);
  }
  const entries = [];
  const chunks = [];
  for (const file of result.outputFiles) {
    const rel = relative(outdir, file.path).split(sep).join('/');
    const name = rel.replace(/\.js$/, '');
    const minified = file.contents.length;
    const gzip = gzipBytes(file.contents);
    if (entryModules.includes(name)) entries.push({ module: name, minified, gzip, inputs: reachableInputs(result.metafile, entryOf.get(file.path)) });
    else chunks.push({ file: rel, minified, gzip });
  }
  entries.sort((a, b) => entryModules.indexOf(a.module) - entryModules.indexOf(b.module));
  const all = [...entries, ...chunks];
  return {
    entries,
    chunks,
    outputs: Object.keys(result.metafile.outputs).length,
    totalGzip: all.reduce((s, r) => s + r.gzip, 0),
    totalMinified: all.reduce((s, r) => s + r.minified, 0),
  };
}

async function main() {
  const { entries, chunks, outputs, totalGzip, totalMinified } = await measureBundle();
  const w = 34;
  console.log('\nTower client bundle (esbuild, minified, entries bundled together, shared chunks counted once):');
  console.log('='.repeat(w + 24));
  console.log('Output'.padEnd(w) + 'Minified'.padStart(12) + 'Gzip'.padStart(12));
  console.log('-'.repeat(w + 24));
  for (const r of entries) {
    console.log(r.module.padEnd(w) + String(r.minified).padStart(12) + String(r.gzip).padStart(12));
  }
  for (const r of chunks) {
    console.log(`(shared) ${r.file}`.padEnd(w) + String(r.minified).padStart(12) + String(r.gzip).padStart(12));
  }
  console.log('-'.repeat(w + 24));
  console.log('Total'.padEnd(w) + String(totalMinified).padStart(12) + String(totalGzip).padStart(12));
  console.log('='.repeat(w + 24));
  console.log(`Total gzip size: ${totalGzip} bytes (${(totalGzip / 1024).toFixed(2)} KB)`);
  return { entries, chunks, outputs, totalGzip, totalMinified };
}

export { main, measureBundle, reachableInputs, gzipBytes, modules, ROOT };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
