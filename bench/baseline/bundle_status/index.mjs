// 현황판 번들 크기. dist 모드: 진입 HTML(res/static/status.html)이 참조하는 자산(script src, modulepreload, stylesheet)과
// 그 JS 의 정적 import 폐포를 모아 파일별 raw/gzip(level 9) 합을 낸다. 청크 이름 정규식은 쓰지 않는다.
// math(three 포함)·geo·style css 같은 공유 청크는 관제탑 번들에도 똑같이 포함된다(method 에 명시).
// 진입 HTML 이 없으면 throw. 대상은 inputs.distDir 이다(빌드는 run_all 담당). skylensDir 은 읽기 전용, outDir 에는 manifest 만 쓴다.
import { gzipSync } from 'node:zlib';
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep, resolve, dirname, isAbsolute } from 'node:path';
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

// ---- dist 진입 HTML 폐포 수집 (이름 정규식을 쓰지 않는다) ----
const ASSET_TAG = /<(script|link)\b[^>]*>/gi;
const ATTR = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
const STATIC_IMPORT = [/\bfrom\s*(["'])([^"'\n]+)\1/g, /\bimport\s*(["'])([^"'\n]+)\1/g];
const isLocalSpec = (s) => s.startsWith('./') || s.startsWith('../') || (s.startsWith('/') && !s.startsWith('//'));

/** 참조 문자열을 dist 안 절대 경로로 푼다. 루트('/x')는 distDir 기준, 상대는 참조한 파일 기준. */
function resolveRef(distDir, fromAbs, spec) {
  const clean = spec.split(/[?#]/)[0];
  const abs = clean.startsWith('/') ? join(distDir, clean) : resolve(dirname(fromAbs), clean);
  const rel = relative(distDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`bundle_status: dist 밖을 가리키는 참조: ${spec} (${fromAbs})`);
  return abs;
}

/** 진입 HTML 의 <script src>, <link rel=modulepreload|stylesheet href> 목록. */
function htmlAssets(distDir, htmlAbs) {
  const html = readFileSync(htmlAbs, 'utf8');
  const out = [];
  for (const m of html.matchAll(ASSET_TAG)) {
    const tag = m[0];
    let ref;
    if (m[1].toLowerCase() === 'script') ref = ATTR(tag, 'src');
    else {
      const rel = ATTR(tag, 'rel');
      const kinds = ((rel && (rel[1] ?? rel[2])) || '').toLowerCase().split(/\s+/);
      if (kinds.includes('modulepreload') || kinds.includes('stylesheet')) ref = ATTR(tag, 'href');
    }
    const spec = ref && (ref[1] ?? ref[2]);
    if (spec && isLocalSpec(spec)) out.push(resolveRef(distDir, htmlAbs, spec));
  }
  return out;
}

/** 진입 HTML 에서 출발해 참조 자산과 JS 정적 import 폐포를 모은다. 경로순 [{rel, abs}]. */
function distClosure(distDir, entryName) {
  const cands = [join(distDir, 'res', 'static', entryName), join(distDir, entryName)];
  const htmlAbs = cands.find((p) => existsSync(p) && statSync(p).isFile());
  if (!htmlAbs) throw new Error(`bundle_status: 진입 HTML 이 없다: ${cands[0]}`);
  const seen = new Map();
  const queue = htmlAssets(distDir, htmlAbs);
  while (queue.length) {
    const abs = queue.shift();
    const rel = posix(relative(distDir, abs));
    if (seen.has(rel)) continue;
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`bundle_status: ${entryName} 가 참조하는 파일이 없다: ${rel}`);
    seen.set(rel, abs);
    if (!/\.m?js$/i.test(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    for (const re of STATIC_IMPORT) {
      for (const m of src.matchAll(re)) if (isLocalSpec(m[2])) queue.push(resolveRef(distDir, abs, m[2]));
    }
  }
  if (!seen.size) throw new Error(`bundle_status: ${entryName} 가 참조하는 자산이 없다`);
  return [...seen.keys()].sort().map((rel) => ({ rel, abs: seen.get(rel) }));
}

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
    const files = distClosure(distDir, 'status.html').map((f) => ({ group: 'closure', path: f.abs, rel: f.rel }));
    return { mode: 'dist', files };
  }
  if (!inputs?.allowSource) {
    throw new Error(`bundle_status: 빌드된 dist 가 필요하다(inputs.distDir). skylensDir(${skylensDir})에서 먼저 빌드해 넘겨라`);
  }
  const files = [];
  const srcDir = join(skylensDir, ...SRC_REL);
  if (await isDir(srcDir)) {
    for (const p of await walk(srcDir)) if (hasExt(p)) files.push({ group: 'statusview', path: p, rel: posix(relative(skylensDir, p)) });
  }
  for (const pkg of PACKAGES) {
    const root = join(skylensDir, ...pkg.parts);
    if (!(await isDir(root))) continue;
    const p = await packageEntry(root);
    files.push({ group: pkg.key, path: p, rel: posix(relative(skylensDir, p)) });
  }
  if (!files.length) throw new Error(`bundle_status: 측정 대상이 없다: ${skylensDir}`);
  return { mode: 'source', files };
}

export async function run({ skylensDir, outDir, commit, inputs }) {
  const { mode, files } = await collect(skylensDir, inputs);
  const totals = new Map(GROUPS.map((g) => [g.key, 0]));
  const manifest = [];
  let raw = 0;
  for (const f of files) {
    const buf = await readFile(f.path);
    const bytes = gz(buf);
    raw += buf.length;
    totals.set(f.group, (totals.get(f.group) ?? 0) + bytes);
    manifest.push({ group: f.group, file: f.rel, gzip_bytes: bytes, raw_bytes: buf.length });
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const method = `${mode}; ` + (mode === 'dist' ? 'status.html entry closure (script/modulepreload/stylesheet + static JS imports); shared chunks (math, geo, style css) are also in the tower bundle; ' : '') + `raw and gzip level 9 per file, summed; ${files.length} files`;
  const base = { unit: 'B', device: 'n/a', method, commit };
  const records = [{ metric: 'bundle_status.gzip_bytes', value: sum, ...base }];
  records.push({ metric: 'bundle_status.raw_bytes', value: raw, ...base });
  if (mode === 'source') for (const [key, value] of totals) records.push({ metric: `bundle_status.${key}.gzip_bytes`, value, ...base });
  assertRecords(records);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'bundle_status.manifest.json'), JSON.stringify({ mode, manifest }, null, 2) + '\n');
  }
  return records;
}
