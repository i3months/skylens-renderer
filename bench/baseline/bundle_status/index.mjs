// 현황판 3D 관련 청크(three, @mkkellogg/gaussian-splats-3d, statusview 코드)의 gzip 바이트 합을 잰다.
// skylensDir 은 읽기 전용이다. outDir 에는 측정 명세(manifest)만 쓴다.
import { gzipSync } from 'node:zlib';
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const EXTS = new Set(['.js', '.mjs', '.cjs', '.css', '.wasm']);
const GROUPS = [
  { key: 'three', re: /(^|[\\/._-])three([\\/._-]|$)/i },
  { key: 'splats', re: /gaussian-?splats|mkkellogg/i },
  { key: 'statusview', re: /statusview/i },
];
const SRC_REL = ['src', 'skylens_client', 'statusview'];
const PACKAGES = [
  { key: 'three', parts: ['node_modules', 'three'] },
  { key: 'splats', parts: ['node_modules', '@mkkellogg', 'gaussian-splats-3d'] },
];

async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/** 디렉터리를 재귀로 훑어 정렬된 파일 경로를 돌려준다. 심볼릭 링크는 따라가지 않는다. */
async function walk(dir) {
  const out = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const hasExt = (p) => EXTS.has(p.slice(p.lastIndexOf('.')).toLowerCase());
const posix = (p) => p.split(sep).join('/');

/** 결정적 gzip: level 9. node 의 gzip 헤더는 mtime 0 이고 OS 바이트가 고정이다. */
function gz(buf) {
  return gzipSync(buf, { level: 9 }).length;
}

/** 측정 대상 파일 목록 [{group, path, rel}] 과 방식 이름을 정한다. */
async function collect(skylensDir) {
  const distDir = join(skylensDir, 'dist');
  if (await isDir(distDir)) {
    const files = [];
    for (const p of await walk(distDir)) {
      const rel = posix(relative(skylensDir, p));
      const g = hasExt(p) && GROUPS.find((x) => x.re.test(rel));
      if (g) files.push({ group: g.key, path: p, rel });
    }
    if (files.length) return { mode: 'dist', files };
  }
  const files = [];
  const srcDir = join(skylensDir, ...SRC_REL);
  if (await isDir(srcDir)) {
    for (const p of await walk(srcDir)) if (hasExt(p)) files.push({ group: 'statusview', path: p, rel: posix(relative(skylensDir, p)) });
  }
  for (const pkg of PACKAGES) {
    let root = join(skylensDir, ...pkg.parts);
    if (!(await isDir(root))) continue;
    // 배포 산출물이 build/ 에 있으면 그쪽만, 없으면 패키지 전체를 쓴다.
    if (await isDir(join(root, 'build'))) root = join(root, 'build');
    for (const p of await walk(root)) if (hasExt(p)) files.push({ group: pkg.key, path: p, rel: posix(relative(skylensDir, p)) });
  }
  if (!files.length) throw new Error(`bundle_status: 측정 대상이 없다 (dist 도 소스도 없음): ${skylensDir}`);
  return { mode: 'source', files };
}

export async function run({ skylensDir, outDir, commit }) {
  const { mode, files } = await collect(skylensDir);
  const totals = new Map(GROUPS.map((g) => [g.key, 0]));
  const manifest = [];
  for (const f of files) {
    const bytes = gz(await readFile(f.path));
    totals.set(f.group, totals.get(f.group) + bytes);
    manifest.push({ group: f.group, file: f.rel, gzip_bytes: bytes });
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const method = `gzip level 9 per file, summed (${mode}, ${files.length} files)`;
  const base = { unit: 'B', device: 'n/a', method, commit };
  const records = [{ metric: 'bundle_status.gzip_bytes', value: sum, ...base }];
  for (const [key, value] of totals) records.push({ metric: `bundle_status.${key}.gzip_bytes`, value, ...base });
  assertRecords(records);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'bundle_status.manifest.json'), JSON.stringify({ mode, manifest }, null, 2) + '\n');
  }
  return records;
}
