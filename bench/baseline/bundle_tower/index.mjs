// 관제탑 3D 번들 크기 기준선 (T01.2). 지표: bundle_tower.gzip_bytes (B).
// 관제탑 3D 관련 파일(three, controlview 코드, 지형·건물 로더)을 파일별로 gzip(level 9) 하여 바이트를 합산한다.
// inputs.distDir(이미 빌드된 dist)의 청크를 잰다. 없으면 빌드 필요로 throw(빌드는 run_all 담당).
// inputs.allowSource 일 때만 소스 모드이며 three 는 패키지 진입점 하나만 잰다(변형 합산 금지). 대상 0개면 throw.
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, existsSync, statSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const METRIC = 'bundle_tower.gzip_bytes';
const CODE_EXT = /\.(?:m?js|cjs|ts|glsl|wgsl|vert|frag)$/i;
const CHUNK_EXT = /\.(?:m?js|cjs)$/i;
// dist 청크 이름 판별: three, controlview, 지형·건물 로더
const DIST_NAME = /(?:^|[\\/._-])(?:three|controlview)(?:[\\/._-]|$)|(?:terrain|building)[^\\/]*loader|loader[^\\/]*(?:terrain|building)/i;
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
    for (const p of walk(dist)) {
      if (CHUNK_EXT.test(p) && DIST_NAME.test(posix(dist, p))) picked.set(posix(dist, p), p);
    }
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
  return gzipSync(buf, { level: 9, memLevel: 9 }).length;
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
  const base = { unit: 'B', device: 'node-zlib', method: `${mode}; 파일별 gzip level 9 합산; 파일 ${files.length}개`, commit };
  return assertRecords([
    { metric: METRIC, value: total, ...base },
    { metric: 'bundle_tower.raw_bytes', value: raw, ...base },
  ]);
}
