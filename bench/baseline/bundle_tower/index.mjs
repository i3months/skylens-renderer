// 관제탑 3D 번들 크기 기준선. 지표: bundle_tower.3d.gzip_bytes(3D 청크만), bundle_tower.gzip_bytes(폐포 전체, 참고값).
// dist 모드: 진입 HTML(res/static/control.html)이 참조하는 자산(script src, modulepreload, stylesheet)과
// 그 JS 의 정적 import·동적 import()·vite mapDeps 폐포를 모아 파일별 raw/gzip(level 9)을 합산한다.
// 3D 합계는 폐포에서 three·splat·렌더러 JS 청크(내용 표지로 판별, CSS 제외)만 더한다. 공통 로직은 ../bundle_status/closure.mjs.
// math(three 포함)·geo·style css 같은 공유 청크는 현황판 번들에도 똑같이 포함된다(method 에 명시).
// 진입 HTML 이 없으면 throw. inputs.distDir 이 없으면 빌드 필요로 throw(빌드는 run_all 담당).
// inputs.allowSource 일 때만 소스 모드이며 three 는 패키지 진입점 하나만 잰다(변형 합산 금지). 대상 0개면 throw.
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, existsSync, statSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { distClosure, sourceClosure, is3d, outsideJs, posix as toPosix, MARKER_DESC } from '../bundle_status/closure.mjs';
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

const posix = (base, p) => toPosix(relative(base, p));

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
  const forced = new Map();
  let mode;
  let unresolved = [];
  let outside = [];
  if (dist) {
    if (!existsSync(dist) || !statSync(dist).isDirectory()) throw new Error(`bundle_tower: distDir 가 디렉터리가 아니다: ${dist}`);
    mode = 'dist';
    const report = {};
    for (const f of distClosure('bundle_tower', dist, 'control.html', report)) {
      picked.set(f.rel, f.abs);
      forced.set(f.rel, f.forced3d);
    }
    unresolved = report.unresolved;
    outside = outsideJs(dist, new Set(picked.keys()));
  } else {
    if (!inputs?.allowSource) {
      throw new Error(`bundle_tower: 빌드된 dist 가 필요하다(inputs.distDir). skylensDir(${skylensDir})에서 먼저 빌드해 넘겨라`);
    }
    mode = 'source';
    const roots = [];
    const addRoot = (p, group) => roots.push({ abs: p, group });
    for (const p of walk(join(skylensDir, 'src', 'skylens_core', 'controlview'))) {
      if (CODE_EXT.test(p)) addRoot(p, 'src');
    }
    for (const p of walk(join(skylensDir, 'src'))) {
      if (CODE_EXT.test(p) && SRC_LOADER.test(posix(skylensDir, p))) addRoot(p, 'src');
    }
    const t = threeEntry(join(skylensDir, 'node_modules', 'three'));
    if (t) addRoot(t, 'three');
    for (const f of sourceClosure(skylensDir, roots)) picked.set(posix(skylensDir, f.abs), f.abs), forced.set(posix(skylensDir, f.abs), f.group === 'three');
  }
  const files = [...picked.keys()].sort().map((rel) => ({ rel, abs: picked.get(rel), forced3d: forced.get(rel) === true }));
  if (!files.length) throw new Error(`bundle_tower: 측정 대상이 없다(${mode}): ${dist ?? skylensDir}`);
  return { mode, files, unresolved, outside };
}

/** 결정적 gzip: level 9, 헤더 mtime 은 zlib 기본값 0. */
export function gzipSize(buf) {
  return gzipSync(buf, { level: 9 }).length;
}

export async function run({ skylensDir, outDir, commit, inputs }) {
  const { mode, files, unresolved, outside } = selectFiles(skylensDir, inputs);
  const bufs = files.map((f) => readFileSync(f.abs));
  const detail = files.map((f, i) => ({ path: f.rel, gzip: gzipSize(bufs[i]), raw: bufs[i].length, is_3d: is3d(f.rel, bufs[i], f.forced3d) }));
  const total = detail.reduce((s, d) => s + d.gzip, 0);
  const raw = detail.reduce((s, d) => s + d.raw, 0);
  const three = detail.filter((d) => d.is_3d);
  const total3 = three.reduce((s, d) => s + d.gzip, 0);
  const raw3 = three.reduce((s, d) => s + d.raw, 0);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'bundle_tower.json'), JSON.stringify({ mode, unresolved, outside_closure_js: outside, total, raw, total_3d: total3, raw_3d: raw3, files: detail }, null, 2) + '\n');
  }
  const closureDesc = mode === 'dist'
    ? 'control.html 진입 폐포(script/modulepreload/stylesheet + 정적 import + 동적 import() + vite mapDeps); 공유 청크(math·geo·style css)는 현황판에도 포함; '
    : '소스 폐포(진입 파일 + 상대 정적/동적 import, three 는 패키지 진입점 하나); three 패키지는 패키지 단위로 3D; ';
  const base = { unit: 'B', device: 'node-zlib', method: `${mode}; ${closureDesc}파일별 raw·gzip level 9 합산; 폐포 파일 ${files.length}개(참고값); 3D 합계(bundle_tower.3d.*) = ${MARKER_DESC}; 3D 파일 ${three.length}개${mode === 'dist' ? `; 못 푼 동적/mapDeps 참조 ${unresolved.length}개${unresolved.length ? ` (경고: 3D 합계가 과소일 수 있다; ${unresolved.slice(0, 5).map((x) => `${x.from} -> ${x.spec}`).join(', ')})` : ''}` : ''}`, commit };
  return assertRecords([
    { metric: 'bundle_tower.3d.gzip_bytes', value: total3, ...base },
    { metric: 'bundle_tower.3d.raw_bytes', value: raw3, ...base },
    { metric: METRIC, value: total, ...base },
    { metric: 'bundle_tower.raw_bytes', value: raw, ...base },
  ]);
}
