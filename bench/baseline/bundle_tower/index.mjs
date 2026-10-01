// 관제탑 3D 번들 크기 기준선 (T01.2). 지표: bundle_tower.gzip_bytes (B).
// dist 모드: 진입 HTML(res/static/control.html)이 참조하는 자산(script src, modulepreload, stylesheet)과
// 그 JS 의 정적 import 폐포를 모아 파일별 raw/gzip(level 9)을 합산한다. 청크 이름 정규식은 쓰지 않는다.
// math(three 포함)·geo·style css 같은 공유 청크는 현황판 번들에도 똑같이 포함된다(method 에 명시).
// 진입 HTML 이 없으면 throw. inputs.distDir 이 없으면 빌드 필요로 throw(빌드는 run_all 담당).
// inputs.allowSource 일 때만 소스 모드이며 three 는 패키지 진입점 하나만 잰다(변형 합산 금지). 대상 0개면 throw.
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, existsSync, statSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep, resolve, dirname, isAbsolute } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const METRIC = 'bundle_tower.gzip_bytes';
const CODE_EXT = /\.(?:m?js|cjs|ts|glsl|wgsl|vert|frag)$/i;
const SRC_LOADER = /(?:terrain|building)[^\\/]*loader|loader[^\\/]*(?:terrain|building)/i;

/** 디렉터리를 정렬된 순서로 재귀 순회한다. 심볼릭 링크는 따라가지 않는다. */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (n === 'node_modules' || n === '.git') continue;
      walk(p, out);
    } else if (st.isFile()) out.push(p);
  }
  return out;
}

const posix = (base, p) => relative(base, p).split(sep).join('/');

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
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`bundle_tower: dist 밖을 가리키는 참조: ${spec} (${fromAbs})`);
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
  if (!htmlAbs) throw new Error(`bundle_tower: 진입 HTML 이 없다: ${cands[0]}`);
  const seen = new Map();
  const queue = htmlAssets(distDir, htmlAbs);
  while (queue.length) {
    const abs = queue.shift();
    const rel = posix(distDir, abs);
    if (seen.has(rel)) continue;
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`bundle_tower: ${entryName} 가 참조하는 파일이 없다: ${rel}`);
    seen.set(rel, abs);
    if (!/\.m?js$/i.test(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    for (const re of STATIC_IMPORT) {
      for (const m of src.matchAll(re)) if (isLocalSpec(m[2])) queue.push(resolveRef(distDir, abs, m[2]));
    }
  }
  if (!seen.size) throw new Error(`bundle_tower: ${entryName} 가 참조하는 자산이 없다`);
  return [...seen.keys()].sort().map((rel) => ({ rel, abs: seen.get(rel) }));
}

/** three 패키지의 ESM 진입점 하나: exports["."].import → module → main. */
function threeEntry(root) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  let e = pkg.exports?.['.'];
  if (e && typeof e === 'object') e = e.import ?? e.default;
  if (e && typeof e === 'object') e = e.default ?? e.import;
  const rel = [e, pkg.module, pkg.main].find((x) => typeof x === 'string');
  if (!rel) throw new Error(`bundle_tower: three 진입점을 알 수 없다: ${pkgPath}`);
  return join(root, rel);
}

/** 측정 대상 파일 목록 선택. { mode, files: [{ rel, abs }] } 를 경로순으로 반환. 대상 0개면 throw. */
export function selectFiles(skylensDir, inputs) {
  const dist = inputs?.distDir;
  const picked = new Map();
  let mode;
  if (dist) {
    if (!existsSync(dist) || !statSync(dist).isDirectory()) throw new Error(`bundle_tower: distDir 가 디렉터리가 아니다: ${dist}`);
    mode = 'dist';
    for (const f of distClosure(dist, 'control.html')) picked.set(f.rel, f.abs);
  } else {
    if (!inputs?.allowSource) {
      throw new Error(`bundle_tower: 빌드된 dist 가 필요하다(inputs.distDir). skylensDir(${skylensDir})에서 먼저 빌드해 넘겨라`);
    }
    mode = 'source';
    const add = (p) => picked.set(posix(skylensDir, p), p);
    for (const p of walk(join(skylensDir, 'src', 'skylens_core', 'controlview'))) {
      if (CODE_EXT.test(p)) add(p);
    }
    for (const p of walk(join(skylensDir, 'src'))) {
      if (CODE_EXT.test(p) && SRC_LOADER.test(posix(skylensDir, p))) add(p);
    }
    const t = threeEntry(join(skylensDir, 'node_modules', 'three'));
    if (t) add(t);
  }
  const files = [...picked.keys()].sort().map((rel) => ({ rel, abs: picked.get(rel) }));
  if (!files.length) throw new Error(`bundle_tower: 측정 대상이 없다(${mode}): ${dist ?? skylensDir}`);
  return { mode, files };
}

/** 결정적 gzip: level 9, 헤더 mtime 은 zlib 기본값 0. */
export function gzipSize(buf) {
  return gzipSync(buf, { level: 9 }).length;
}

export async function run({ skylensDir, outDir, commit, inputs }) {
  const { mode, files } = selectFiles(skylensDir, inputs);
  const bufs = files.map((f) => readFileSync(f.abs));
  const detail = files.map((f, i) => ({ path: f.rel, gzip: gzipSize(bufs[i]), raw: bufs[i].length }));
  const total = detail.reduce((s, d) => s + d.gzip, 0);
  const raw = detail.reduce((s, d) => s + d.raw, 0);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'bundle_tower.json'), JSON.stringify({ mode, total, raw, files: detail }, null, 2) + '\n');
  }
  const base = { unit: 'B', device: 'node-zlib', method: `${mode}; ` + (mode === 'dist' ? 'control.html 진입 폐포(script/modulepreload/stylesheet + JS 정적 import); 공유 청크(math·geo·style css)는 현황판에도 포함; ' : '') + `파일별 raw·gzip level 9 합산; 파일 ${files.length}개`, commit };
  return assertRecords([
    { metric: METRIC, value: total, ...base },
    { metric: 'bundle_tower.raw_bytes', value: raw, ...base },
  ]);
}
