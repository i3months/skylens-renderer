// One-command runner for the baseline measurements (T01.10).
// CLI: SKYLENS_DIR=<checkout> node bench/baseline/run_all/index.mjs --out <dir> [--allow-missing]
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';

export const MODULES = [
  'bundle_status', 'bundle_tower', 'asset_bytes', 'ws_bytes',
  'tower_bytes', 'first_frame', 'heap', 'ref_images',
];

const here = dirname(fileURLToPath(import.meta.url));

/** Default loader: imports ../<name>/index.mjs; returns null if that module file does not exist. */
export async function defaultLoader(name) {
  const file = join(here, '..', name, 'index.mjs');
  try {
    return await import(pathToFileURL(file).href);
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(file)) return null;
    throw e;
  }
}

export function resolveCommit(skylensDir) {
  return execFileSync('git', ['-C', skylensDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/**
 * Runs modules sequentially. `modules` is an ordered list of names, or an object {name: {run}}
 * (injected). Returns {records, failures, missing, outFile}; records.json is written only when
 * there are no failures.
 */
export async function runAll({
  skylensDir, outDir, commit, modules = MODULES, allowMissing = false,
  loader = defaultLoader, log = () => {},
}) {
  if (!skylensDir) throw new Error('skylensDir is required');
  if (!outDir) throw new Error('outDir is required');
  commit ??= resolveCommit(skylensDir);
  const entries = Array.isArray(modules)
    ? modules.map((n) => [n, null])
    : Object.entries(modules);
  const records = [];
  const failures = [];
  const missing = [];
  await mkdir(outDir, { recursive: true });
  for (const [name, injected] of entries) {
    let mod = injected;
    try {
      mod ??= await loader(name);
    } catch (e) {
      failures.push({ module: name, error: `import failed: ${e?.message ?? e}` });
      continue;
    }
    if (!mod) {
      missing.push(name);
      if (!allowMissing) failures.push({ module: name, error: 'module missing' });
      log(`${name}: missing`);
      continue;
    }
    if (typeof mod.run !== 'function') {
      failures.push({ module: name, error: 'module does not export run()' });
      continue;
    }
    try {
      const out = await mod.run({ skylensDir, outDir, commit });
      if (!Array.isArray(out)) throw new Error('run() did not return an array');
      assertRecords(out);
      records.push(...out);
      log(`${name}: ${out.length} records`);
    } catch (e) {
      failures.push({ module: name, error: e?.message ?? String(e) });
    }
  }
  let outFile = null;
  if (!failures.length) {
    outFile = join(outDir, 'records.json');
    await writeFile(outFile, serialize(records));
  }
  return { records, failures, missing, outFile };
}

export function parseArgs(argv) {
  const a = { out: null, allowMissing: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--allow-missing') a.allowMissing = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!a.out) throw new Error('usage: index.mjs --out <dir> [--allow-missing]');
  return a;
}

async function main() {
  const { out, allowMissing } = parseArgs(process.argv.slice(2));
  const skylensDir = process.env.SKYLENS_DIR;
  if (!skylensDir) throw new Error('SKYLENS_DIR is not set');
  const res = await runAll({
    skylensDir: resolve(skylensDir), outDir: resolve(out), allowMissing,
    log: (m) => console.log(m),
  });
  for (const f of res.failures) console.error(`FAIL ${f.module}: ${f.error}`);
  if (res.failures.length) process.exit(1);
  console.log(`wrote ${res.records.length} records to ${res.outFile}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
