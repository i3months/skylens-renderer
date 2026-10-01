// 번들 측정 공통 로직(현황판·관제탑이 함께 쓴다): 정적 import·동적 import()·vite mapDeps 추적과 3D 청크 판별.
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep, resolve, dirname, isAbsolute } from 'node:path';

export const posix = (p) => p.split(sep).join('/');
export const isLocalSpec = (s) => s.startsWith('./') || s.startsWith('../') || (s.startsWith('/') && !s.startsWith('//'));
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const isJs = (p) => /\.m?js$/i.test(p);

const ASSET_TAG = /<(script|link)\b[^>]*>/gi;
const ATTR = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
const STATIC_IMPORT = [/\bfrom\s*(["'])([^"'\n]+)\1/g, /\bimport\s*(["'])([^"'\n]+)\1/g];
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const MAP_DEPS_ARRAY = /\.f\s*=\s*\[([^\]]*)\]/g;
const QUOTED = /(["'])([^"'\n]+)\1/g;

// 3D 청크 판별 근거: JS 내용에 three·splat·렌더러 식별자가 들어 있는가(이름이 아니라 내용으로 본다).
export const MARKER_3D = /WebGLRenderer|WebGL2?RenderingContext|BufferGeometry|Matrix4|[Ss]plat|[Gg]aussian|\bthree\b|\bTHREE\b|getContext\(\s*["']webgl/;
export const MARKER_DESC = 'JS chunk whose content has three/splat/renderer identifiers (WebGLRenderer, WebGL(2)RenderingContext, BufferGeometry, Matrix4, Splat*, Gaussian*, three, getContext("webgl")); CSS, wasm and other assets excluded';

/** JS 소스에서 정적 import, 동적 import(), vite mapDeps 항목을 뽑는다. [{spec, kind}] kind: static|dynamic|mapdeps */
export function importsOf(src) {
  const out = [];
  for (const re of STATIC_IMPORT) for (const m of src.matchAll(re)) out.push({ spec: m[2], kind: 'static' });
  for (const m of src.matchAll(DYNAMIC_IMPORT)) out.push({ spec: m[2], kind: 'dynamic' });
  if (src.includes('__vite__mapDeps')) {
    for (const a of src.matchAll(MAP_DEPS_ARRAY)) for (const q of a[1].matchAll(QUOTED)) out.push({ spec: q[2], kind: 'mapdeps' });
  }
  return out;
}

/** 3D 청크인가: JS 이고 내용에 표지가 있다. forced 는 패키지 경로처럼 외부에서 3D 로 확정한 경우. */
export function is3d(rel, buf, forced = false) {
  if (!isJs(rel)) return false;
  return forced || MARKER_3D.test(buf.toString('utf8'));
}

/** 참조를 dist 안 절대 경로로 푼다. 루트('/x')는 distDir 기준, 상대는 참조한 파일 기준. */
function resolveRef(label, distDir, fromAbs, spec) {
  const clean = spec.split(/[?#]/)[0];
  const abs = clean.startsWith('/') ? join(distDir, clean) : resolve(dirname(fromAbs), clean);
  const rel = relative(distDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${label}: dist 밖을 가리키는 참조: ${spec} (${fromAbs})`);
  return abs;
}

/** mapDeps 항목은 base 기준 경로(assets/x.js)다. dist 루트 기준을 먼저, 없으면 참조한 파일 기준으로 푼다. */
function resolveMapDep(distDir, fromAbs, spec) {
  const noQuery = spec.split(/[?#]/)[0];
  for (const abs of [join(distDir, noQuery.replace(/^\.?\//, '')), resolve(dirname(fromAbs), noQuery)]) {
    const rel = relative(distDir, abs);
    if (!rel.startsWith('..') && !isAbsolute(rel) && isFile(abs)) return abs;
  }
  return null;
}

function htmlAssets(label, distDir, htmlAbs) {
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
    if (spec && isLocalSpec(spec)) out.push(resolveRef(label, distDir, htmlAbs, spec));
  }
  return out;
}

/**
 * 진입 HTML 에서 출발해 참조 자산, JS 정적 import, 동적 import(), mapDeps 청크를 따라간 폐포.
 * 정적 참조 파일이 없으면 throw, 동적·mapDeps 대상이 없으면(선택 청크) 건너뛴다. 경로순 [{rel, abs}].
 */
export function distClosure(label, distDir, entryName) {
  const cands = [join(distDir, 'res', 'static', entryName), join(distDir, entryName)];
  const htmlAbs = cands.find(isFile);
  if (!htmlAbs) throw new Error(`${label}: 진입 HTML 이 없다: ${cands[0]}`);
  const seen = new Map();
  const queue = htmlAssets(label, distDir, htmlAbs).map((abs) => ({ abs, optional: false }));
  while (queue.length) {
    const { abs, optional } = queue.shift();
    const rel = posix(relative(distDir, abs));
    if (seen.has(rel)) continue;
    if (!isFile(abs)) {
      if (optional) continue;
      throw new Error(`${label}: ${entryName} 가 참조하는 파일이 없다: ${rel}`);
    }
    seen.set(rel, abs);
    if (!isJs(abs)) continue;
    for (const { spec, kind } of importsOf(readFileSync(abs, 'utf8'))) {
      if (kind === 'mapdeps') {
        const dep = resolveMapDep(distDir, abs, spec);
        if (dep) queue.push({ abs: dep, optional: true });
      } else if (isLocalSpec(spec)) queue.push({ abs: resolveRef(label, distDir, abs, spec), optional: kind === 'dynamic' });
    }
  }
  if (!seen.size) throw new Error(`${label}: ${entryName} 가 참조하는 자산이 없다`);
  return [...seen.keys()].sort().map((rel) => ({ rel, abs: seen.get(rel) }));
}

function resolveSourceSpec(fromAbs, spec) {
  const base = resolve(dirname(fromAbs), spec.split(/[?#]/)[0]);
  for (const c of [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')]) if (isFile(c)) return c;
  return null;
}

/**
 * 소스 모드: 시작 파일들에서 상대 import(정적·동적)를 따라간다. skylensDir 밖·없는 파일·bare 지정자는 건너뛴다.
 * roots: [{abs, group}]. 반환 [{abs, group}] — 먼저 닿은 시작 파일의 group 을 물려받는다.
 */
export function sourceClosure(skylensDir, roots) {
  const seen = new Map();
  const queue = [...roots];
  while (queue.length) {
    const { abs, group } = queue.shift();
    if (seen.has(abs) || !isFile(abs)) continue;
    seen.set(abs, group);
    if (!isJs(abs)) continue;
    for (const { spec, kind } of importsOf(readFileSync(abs, 'utf8'))) {
      if (kind === 'mapdeps' || !isLocalSpec(spec) || spec.startsWith('/')) continue;
      const dep = resolveSourceSpec(abs, spec);
      const rel = dep && relative(skylensDir, dep);
      if (dep && !rel.startsWith('..') && !isAbsolute(rel)) queue.push({ abs: dep, group });
    }
  }
  return [...seen].map(([abs, group]) => ({ abs, group }));
}
