// Gzip size of the control-tower 3D view bundle (T01.2).
// Builds an entry that pulls in TowerViewer (+ three) and the shared viewer
// sources (terrain, building, scene data) with esbuild, from a temp copy of skylens.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync, constants } from 'node:zlib';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const ENTRY = `export { TowerViewer } from './src/skylens_core/controlview/towerViewer.ts';
export * from './src/shared/viewer/sources/terrainSource.ts';
export * from './src/shared/viewer/sources/buildingSource.ts';
export * from './src/shared/viewer/sources/sceneData.ts';
`;

export async function run({ skylensDir, outDir, commit }) {
  const src = resolve(skylensDir);
  const work = mkdtempSync(join(tmpdir(), 'bundle_tower-'));
  try {
    cpSync(join(src, 'src'), join(work, 'src'), { recursive: true });
    for (const f of ['package.json', 'tsconfig.json']) cpSync(join(src, f), join(work, f));
    symlinkSync(join(src, 'node_modules'), join(work, 'node_modules'), 'dir');
    writeFileSync(join(work, 'tower_entry.ts'), ENTRY);
    const out = join(work, 'out.js');
    execFileSync(
      join(src, 'node_modules/.bin/esbuild'),
      ['tower_entry.ts', '--bundle', '--minify', '--format=esm', '--platform=browser', '--target=es2022',
        '--legal-comments=none', '--log-level=error', `--outfile=${out}`],
      { cwd: work, stdio: 'inherit' },
    );
    const js = readFileSync(out);
    const gz = gzipSync(js, { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'tower.min.js.gz'), gz);
    const base = { device: 'build', method: 'esbuild-minify+gzip-9', commit };
    return assertRecords([
      { metric: 'bundle.tower.gzip', value: gz.length, unit: 'B', ...base },
      { metric: 'bundle.tower.raw', value: js.length, unit: 'B', ...base },
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
