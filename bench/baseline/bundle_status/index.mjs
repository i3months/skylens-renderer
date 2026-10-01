// 현황판 번들 크기. dist 모드: 진입 HTML(res/static/status.html)이 참조하는 자산(script src, modulepreload, stylesheet)과
// 그 JS 의 정적 import·동적 import()·vite mapDeps 폐포를 모아 파일별 raw/gzip(level 9) 합을 낸다(참고값).
// 3D 지표(bundle_status.3d.*)는 그 폐포에서 three·splat·렌더러 JS 청크만 합산한다(내용 표지로 판별, CSS 제외).
// math(three 포함)·geo·style css 같은 공유 청크는 관제탑 번들에도 똑같이 포함된다(method 에 명시).
// 진입 HTML 이 없으면 throw. 대상은 inputs.distDir 이다(빌드는 run_all 담당). skylensDir 은 읽기 전용, outDir 에는 manifest 만 쓴다.
import { gzipSync } from 'node:zlib';
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { distClosure, sourceClosure, is3d, MARKER_DESC } from './closure.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const EXTS = new Set(['.js', '.mjs', '.cjs', '.css', '.wasm']);
const GROUPS = [{ key: 'three' }, { key: 'splats' }, { key: 'statusview' }]; // 소스 모드 전용 그룹
const SRC_REL = ['src', 'skylens_client', 'statusview'];
// 소스 모드는 패키지 진입점 하나만 잰다(build/ 의 cjs·min·webgpu 변형을 합산하지 않는다).
const PACKAGES = [
  { key: 'three', parts: ['node_modules', 'three'] },
  { key: 'splats', parts: ['node_modules', '@mkkellogg', 'gaussian-splats-3d'] },
];

/** package.json 에서 ESM 진입점 하나를 고른다: exports["."].import → module → main. */
export async function packageEntry(root) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  let e = pkg.exports?.['.'];
  if (e && typeof e === 'object') e = e.import ?? e.default;
  if (e && typeof e === 'object') e = e.default ?? e.import;
  const rel = [e, pkg.module, pkg.main].find((x) => typeof x === 'string');
  if (!rel) throw new Error(`bundle_status: 패키지 진입점을 알 수 없다: ${join(root, 'package.json')}`);
  return join(root, rel);
}

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

/**
 * 측정 대상 파일 목록 [{group, path, rel}] 과 방식 이름을 정한다.
 * inputs.distDir(이미 빌드된 dist)가 있으면 그것만 잰다. 없으면 빌드가 필요하다고 throw 한다
 * (빌드는 run_all 이 하고 distDir 로 넘긴다). inputs.allowSource 일 때만 소스 모드(진입점 하나씩).
 */
async function collect(skylensDir, inputs) {
  const distDir = inputs?.distDir;
  if (distDir) {
    if (!(await isDir(distDir))) throw new Error(`bundle_status: distDir 가 디렉터리가 아니다: ${distDir}`);
    const files = distClosure('bundle_status', distDir, 'status.html').map((f) => ({ group: 'closure', path: f.abs, rel: f.rel }));
    return { mode: 'dist', files };
  }
  if (!inputs?.allowSource) {
    throw new Error(`bundle_status: 빌드된 dist 가 필요하다(inputs.distDir). skylensDir(${skylensDir})에서 먼저 빌드해 넘겨라`);
  }
  const roots = [];
  const srcDir = join(skylensDir, ...SRC_REL);
  if (await isDir(srcDir)) {
    for (const p of await walk(srcDir)) if (hasExt(p)) roots.push({ abs: p, group: 'statusview' });
  }
  for (const pkg of PACKAGES) {
    const root = join(skylensDir, ...pkg.parts);
    if (await isDir(root)) roots.push({ abs: await packageEntry(root), group: pkg.key });
  }
  const files = sourceClosure(skylensDir, roots).map((f) => ({ group: f.group, path: f.abs, rel: posix(relative(skylensDir, f.abs)), forced3d: f.group !== 'statusview' }));
  files.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
  if (!files.length) throw new Error(`bundle_status: 측정 대상이 없다: ${skylensDir}`);
  return { mode: 'source', files };
}

export async function run({ skylensDir, outDir, commit, inputs }) {
  const { mode, files } = await collect(skylensDir, inputs);
  const totals = new Map(GROUPS.map((g) => [g.key, 0]));
  const manifest = [];
  let raw = 0;
  let gz3 = 0;
  let raw3 = 0;
  for (const f of files) {
    const buf = await readFile(f.path);
    const bytes = gz(buf);
    raw += buf.length;
    totals.set(f.group, (totals.get(f.group) ?? 0) + bytes);
    const three = is3d(f.rel, buf, f.forced3d);
    if (three) { gz3 += bytes; raw3 += buf.length; }
    manifest.push({ group: f.group, file: f.rel, gzip_bytes: bytes, raw_bytes: buf.length, is_3d: three });
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const closureDesc = mode === 'dist'
    ? 'status.html entry closure (script/modulepreload/stylesheet + static imports + dynamic import() + vite mapDeps); shared chunks (math, geo, style css) are also in the tower bundle; '
    : 'source closure (entry files + relative static/dynamic imports, one entry per package); packages three and gaussian-splats-3d are 3D by package; ';
  const method = `${mode}; ` + closureDesc + `raw and gzip level 9 per file, summed; ${files.length} files in closure (reference total); 3D total (bundle_status.3d.*) = ${MARKER_DESC}; ${manifest.filter((m) => m.is_3d).length} 3D files`;
  const base = { unit: 'B', device: 'n/a', method, commit };
  const records = [{ metric: 'bundle_status.3d.gzip_bytes', value: gz3, ...base }];
  records.push({ metric: 'bundle_status.3d.raw_bytes', value: raw3, ...base });
  records.push({ metric: 'bundle_status.gzip_bytes', value: sum, ...base });
  records.push({ metric: 'bundle_status.raw_bytes', value: raw, ...base });
  if (mode === 'source') for (const [key, value] of totals) records.push({ metric: `bundle_status.${key}.gzip_bytes`, value, ...base });
  assertRecords(records);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'bundle_status.manifest.json'), JSON.stringify({ mode, manifest }, null, 2) + '\n');
  }
  return records;
}
