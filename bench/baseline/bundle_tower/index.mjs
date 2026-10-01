// 관제탑 3D 번들 크기 기준선 (T01.2). 지표: bundle_tower.gzip_bytes (B).
// 관제탑 3D 관련 파일(three, controlview 코드, 지형·건물 로더)을 파일별로 gzip(level 9) 하여 바이트를 합산한다.
// dist 가 있으면 빌드 청크를, 없으면 소스와 node_modules 의 three 패키지를 대상으로 한다.
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, existsSync, statSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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

/** 측정 대상 파일 목록 선택. { mode, files: [{ rel, abs }] } 를 경로순으로 반환. */
export function selectFiles(skylensDir) {
  const dist = join(skylensDir, 'dist');
  const picked = new Map();
  const add = (p) => picked.set(posix(skylensDir, p), p);
  let mode;
  if (existsSync(dist) && statSync(dist).isDirectory()) {
    mode = 'dist';
    for (const p of walk(dist)) {
      if (CHUNK_EXT.test(p) && DIST_NAME.test(posix(dist, p))) add(p);
    }
  } else {
    mode = 'source';
    for (const p of walk(join(skylensDir, 'src', 'skylens_core', 'controlview'))) {
      if (CODE_EXT.test(p)) add(p);
    }
    for (const p of walk(join(skylensDir, 'src'))) {
      if (CODE_EXT.test(p) && SRC_LOADER.test(posix(skylensDir, p))) add(p);
    }
    for (const p of walk(join(skylensDir, 'node_modules', 'three', 'build'))) {
      if (CHUNK_EXT.test(p) && !/\.min\./.test(p)) add(p);
    }
  }
  const files = [...picked.keys()].sort().map((rel) => ({ rel, abs: picked.get(rel) }));
  return { mode, files };
}

/** 결정적 gzip: level 9, 헤더 mtime 은 zlib 기본값 0. */
export function gzipSize(buf) {
  return gzipSync(buf, { level: 9, memLevel: 9 }).length;
}

export async function run({ skylensDir, outDir, commit }) {
  const { mode, files } = selectFiles(skylensDir);
  const detail = files.map((f) => ({ path: f.rel, gzip: gzipSize(readFileSync(f.abs)) }));
  const total = detail.reduce((s, d) => s + d.gzip, 0);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'bundle_tower.json'), JSON.stringify({ mode, total, files: detail }, null, 2) + '\n');
  }
  return [{
    metric: METRIC,
    value: total,
    unit: 'B',
    device: 'node-zlib',
    method: `${mode}; 파일별 gzip level 9 합산; 파일 ${files.length}개`,
    commit,
  }];
}
