// bundle_tower 측정 테스트. 모의 dist 를 distDir 로 넘긴다. 기준값은 독립 계산(python gzip -9)한 고정 숫자.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { run } from './index.mjs';

const COMMIT = 'abc1234';
const THREE = 'abcdefg\n'.repeat(500); // raw 4000, gzip 50
const CTRL = 'wxyz123\n'.repeat(250); // raw 2000, gzip 43
const LOADER = '4567890\n'.repeat(100); // raw 800, gzip 36
const put = (root, rel, text) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const val = (r, m) => r.find((x) => x.metric === m).value;
const noMethod = ({ method, ...rest }) => rest;


// 모의 dist 의 파일 내용. 기준값(raw/gzip)은 이 내용을 python gzip -9 로 독립 계산해 박았다.
const FILES = {
  'status-A.js': 'import{i as e}from"./geo-B.js";import{a as t}from"./math-C.js";import"/assets/side-S.js";\n' + 'status-body;\n'.repeat(100), // 1390 / 106
  'geo-B.js': 'import{d as q}from"./deep-F.js";\n' + 'geo-body-xx;\n'.repeat(60), // 813 / 70
  'math-C.js': 'export const three=1;\n' + 'math-body-yy;\n'.repeat(400), // 5622 / 84
  'deep-F.js': 'export const d=1;\n' + 'deep-body-zz;\n'.repeat(30), // 438 / 54
  'side-S.js': 'export const s=1;\n' + 'side-body;\n'.repeat(20), // 238 / 49
  'status-D.css': '.a{color:red}\n'.repeat(50), // 700 / 41
  'style-E.css': '.b{margin:0}\n'.repeat(80), // 1040 / 42
  'control-G.js': 'import{n as e}from"./geo-B.js";import{t as r}from"./math-C.js";\n' + 'control-body;\n'.repeat(70) + 'const l=()=>import("./drone-Z.js");\n', // 1080 / 116
  'control-H.css': '.c{top:0}\n'.repeat(40), // 400 / 35
};
const html = (js, css) => `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/${js}"></script>
<link rel="modulepreload" crossorigin href="/assets/geo-B.js">
<link rel="modulepreload" crossorigin href="/assets/math-C.js">
<link rel="stylesheet" crossorigin href="/assets/${css}">
<link rel="stylesheet" crossorigin href="/assets/style-E.css">
<link rel="icon" href="/favicon.svg">
</head><body></body></html>`;
// 기대값: tower = 공유(geo+math+deep+style) + control-G + control-H
const TOWER = { raw: 9393, gzip: 401 };

function mockDist() {
  const root = mkdtempSync(join(tmpdir(), 'sky-dist-'));
  for (const [n, t] of Object.entries(FILES)) put(root, `assets/${n}`, t);
  put(root, 'res/static/status.html', html('status-A.js', 'status-D.css'));
  put(root, 'res/static/control.html', html('control-G.js', 'control-H.css'));
  put(root, 'assets/math-C.js.map', JSON.stringify({ sources: ['../../node_modules/three/src/math/Matrix4.js'] }));
  return root;
}

test('dist: control.html 폐포의 raw/gzip 합이 박아 둔 숫자와 같다', async () => {
  const dist = mockDist();
  const out = mkdtempSync(join(tmpdir(), 'sky-out-'));
  try {
    const r = await run({ skylensDir: '/nonexistent', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    assert.equal(val(r, 'bundle_tower.gzip_bytes'), TOWER.gzip);
    assert.equal(val(r, 'bundle_tower.raw_bytes'), TOWER.raw);
    assert.equal(val(r, 'bundle_tower.3d.gzip_bytes'), 84);
    assert.equal(val(r, 'bundle_tower.3d.raw_bytes'), 5622);
    assert.ok(val(r, 'bundle_tower.3d.gzip_bytes') < val(r, 'bundle_tower.gzip_bytes'));
    assert.match(r[0].method, /sourcemap/);
    const d3 = JSON.parse(readFileSync(join(out, 'bundle_tower.json'), 'utf8')).files.filter((f) => f.is_3d);
    assert.deepEqual(d3.map((f) => f.path), ['assets/math-C.js']);
    assert.equal(d3.some((f) => f.path.endsWith('.css')), false);
    assert.equal(r[0].unit, 'B');
    assert.match(r[0].method, /공유 청크/);
    const d = JSON.parse(readFileSync(join(out, 'bundle_tower.json'), 'utf8'));
    assert.deepEqual(d.files.map((f) => f.path), ['assets/control-G.js', 'assets/control-H.css', 'assets/deep-F.js', 'assets/geo-B.js', 'assets/math-C.js', 'assets/style-E.css']);
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('이름이 three/controlview 같은 무관 청크·변형을 추가해도 값 불변', async () => {
  const dist = mockDist();
  try {
    const inputs = { distDir: dist };
    const a = await run({ skylensDir: '/x', commit: COMMIT, inputs });
    put(dist, 'assets/three-ZZ.js', 'k'.repeat(9000));
    put(dist, 'assets/controlview-QQ.js', 'k'.repeat(9000));
    put(dist, 'assets/terrain-loader-9.js', 'k'.repeat(9000));
    put(dist, 'assets/unrelated-C.js.map', 'm'.repeat(9000));
    put(dist, 'index.html', '<html></html>');
    assert.deepEqual((await run({ skylensDir: '/x', commit: COMMIT, inputs })).map(noMethod), a.map(noMethod)); // method 에는 폐포 밖 JS 경고가 붙으므로 method 만 뺀 나머지 필드를 모두 비교한다
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('동적 import() 청크가 폐포에 들어가고, 3D 표지가 있을 때만 3D 합계에 들어간다', async () => {
  const dist = mockDist();
  try {
    const inputs = { distDir: dist };
    const a = await run({ skylensDir: '/x', commit: COMMIT, inputs });
    put(dist, 'assets/drone-Z.js', 'export const x=1;\n'.repeat(200));
    const b = await run({ skylensDir: '/x', commit: COMMIT, inputs });
    assert.ok(val(b, 'bundle_tower.raw_bytes') > val(a, 'bundle_tower.raw_bytes'));
    assert.equal(val(b, 'bundle_tower.3d.gzip_bytes'), val(a, 'bundle_tower.3d.gzip_bytes'));
    put(dist, 'assets/drone-Z.js', 'new THREE.WebGLRenderer();\n'.repeat(200));
    const c = await run({ skylensDir: '/x', commit: COMMIT, inputs });
    assert.ok(val(c, 'bundle_tower.3d.gzip_bytes') > val(a, 'bundle_tower.3d.gzip_bytes'));
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('vite mapDeps 에 적힌 청크(js·css)가 폐포에 들어간다, 없는 항목은 건너뛴다', async () => {
  const dist = mockDist();
  try {
    const inputs = { distDir: dist };
    const a = await run({ skylensDir: '/x', commit: COMMIT, inputs });
    put(dist, 'assets/control-G.js', FILES['control-G.js'] + 'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/lazy-M.js","assets/lazy-M.css","assets/gone.js"])))=>i.map(i=>d[i]);\n');
    put(dist, 'assets/lazy-M.js', 'const r=new WebGLRenderer();\n'.repeat(50));
    put(dist, 'assets/lazy-M.css', '.z{top:1px}\n'.repeat(50));
    const b = await run({ skylensDir: '/x', commit: COMMIT, inputs });
    assert.ok(val(b, 'bundle_tower.raw_bytes') > val(a, 'bundle_tower.raw_bytes') + 1000);
    assert.ok(val(b, 'bundle_tower.3d.gzip_bytes') > val(a, 'bundle_tower.3d.gzip_bytes'));
    assert.ok(val(b, 'bundle_tower.3d.raw_bytes') < val(b, 'bundle_tower.raw_bytes'));
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('진입 HTML 이 없으면 reject, 참조 파일이 없어도 reject', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'sky-empty-'));
  try {
    put(dist, 'assets/three-AA.js', 'u'.repeat(100));
    await assert.rejects(run({ skylensDir: '/x', commit: COMMIT, inputs: { distDir: dist } }), /진입 HTML/);
    put(dist, 'res/static/control.html', html('control-G.js', 'control-H.css'));
    await assert.rejects(run({ skylensDir: '/x', commit: COMMIT, inputs: { distDir: dist } }), /control-G\.js/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('같은 dist 를 두 번 재면 같다(빌드 재현성이 아니라 같은 dist 재계측)', async () => {
  const dist = mockDist();
  try {
    const inputs = { distDir: dist };
    const a = await run({ skylensDir: '/x', commit: COMMIT, inputs });
    const b = await run({ skylensDir: '/x', commit: COMMIT, inputs });
    assert.deepEqual(a, b);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('source(opt-in): three.module.js 가 import 하는 three.core.js 가 포함되고 변형은 값에 영향 없다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sky-src-'));
  try {
    put(root, 'src/skylens_core/controlview/scene.js', CTRL);
    put(root, 'src/loaders/terrainLoader.js', LOADER);
    put(root, 'node_modules/three/package.json', JSON.stringify({ exports: { '.': { import: './build/three.module.js', require: './build/three.cjs' } } }));
    put(root, 'node_modules/three/build/three.module.js', THREE);
    const inputs = { allowSource: true };
    const a = await run({ skylensDir: root, commit: COMMIT, inputs });
    assert.equal(val(a, 'bundle_tower.gzip_bytes'), 129);
    assert.equal(val(a, 'bundle_tower.raw_bytes'), 6800);
    for (const n of ['three.cjs', 'three.min.js', 'three.webgpu.js', 'three.webgpu.min.js']) {
      put(root, `node_modules/three/build/${n}`, 'k'.repeat(7000));
    }
    assert.deepEqual(await run({ skylensDir: root, commit: COMMIT, inputs }), a);
    // module.js 가 core.js 를 import 하면 core.js 도 3D 에 합산된다
    put(root, 'node_modules/three/build/three.module.js', "export * from './three.core.js';\n" + THREE);
    put(root, 'node_modules/three/build/three.core.js', 'core-body-aa\n'.repeat(300));
    const out = mkdtempSync(join(tmpdir(), 'sky-out-'));
    const c = await run({ skylensDir: root, outDir: out, commit: COMMIT, inputs });
    const d = JSON.parse(readFileSync(join(out, 'bundle_tower.json'), 'utf8'));
    rmSync(out, { recursive: true, force: true });
    assert.ok(d.files.some((f) => f.path.endsWith('three.core.js') && f.is_3d));
    assert.equal(d.files.some((f) => /three\.(cjs|min|webgpu)/.test(f.path)), false);
    assert.ok(val(c, 'bundle_tower.3d.gzip_bytes') > val(a, 'bundle_tower.3d.gzip_bytes'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('소스 대상 0개 → reject, distDir 없음 → 빌드 필요로 reject', async () => {
  await assert.rejects(run({ skylensDir: '/nonexistent', commit: COMMIT }), /dist 가 필요/);
  await assert.rejects(run({ skylensDir: '/nonexistent', commit: COMMIT, inputs: { allowSource: true } }), /측정 대상/);
});

test('run 이 assertRecords 를 호출한다: 잘못된 commit 은 reject', async () => {
  const dist = mockDist();
  try {
    await assert.rejects(run({ skylensDir: '/x', commit: 'not-a-hash', inputs: { distDir: dist } }), /record 0/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('dist: 진입 HTML 이 하위 디렉터리여도 mapDeps·동적 import 3형태가 폐포에 들어가고 못 푼 참조는 method·json 에 기록된다', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'sky-sub-'));
  const out = mkdtempSync(join(tmpdir(), 'sky-out-'));
  try {
    put(dist, 'res/static/control.html', '<!doctype html><script type="module" src="./assets/entry.js"></script>');
    put(dist, 'res/static/assets/entry.js', [
      'import("./c1.js",{with:{}});',
      'const b=()=>import(`./c2.js`);',
      'const u=new URL("./c3.js",import.meta.url);',
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/three-a.js","assets/gone.js"])))=>i.map(i=>d[i]);',
    ].join('\n') + '\n');
    for (const n of ['c1', 'c2', 'c3']) put(dist, `res/static/assets/${n}.js`, `export const ${n}=1;\n`);
    put(dist, 'res/static/assets/three-a.js', 'const q=1;\n'.repeat(50));
    put(dist, 'res/static/assets/three-a.js.map', JSON.stringify({ sources: ['../../node_modules/three/src/core/Object3D.js'] }));
    put(dist, 'res/static/assets/stray.js', 'export const z=1;\n');
    const r = await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const j = JSON.parse(readFileSync(join(out, 'bundle_tower.json'), 'utf8'));
    const paths = j.files.map((f) => f.path);
    for (const n of ['entry', 'three-a', 'c1', 'c2', 'c3']) assert.ok(paths.includes(`res/static/assets/${n}.js`), n);
    assert.deepEqual(j.files.filter((f) => f.is_3d).map((f) => f.path), ['res/static/assets/three-a.js']);
    assert.match(r[0].method, /못 푼 동적\/mapDeps 참조 1개 \(경고.*assets\/gone\.js/);
    assert.deepEqual(j.outside_closure_js, ['res/static/assets/stray.js']);
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('dist: CSS 에 3D 표지 문구가 있어도 3D 합계에서 빠진다', async () => {
  const dist = mockDist();
  const out = mkdtempSync(join(tmpdir(), 'sky-out-'));
  try {
    put(dist, 'assets/control-H.css', '/* three splat Gaussian WebGLRenderer */\n.c{top:0}\n');
    await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const f = JSON.parse(readFileSync(join(out, 'bundle_tower.json'), 'utf8')).files;
    assert.equal(f.find((x) => x.path === 'assets/control-H.css').is_3d, false);
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('dist: 문구에 three·Splat 만 있는 청크는 3D 가 아니고 sourcemap three 청크는 3D 이며, 폐포 밖 JS 경고가 남는다', async () => {
  const dist = mockDist();
  const out = mkdtempSync(join(tmpdir(), 'sky-out-'));
  try {
    put(dist, 'assets/control-G.js', FILES['control-G.js'] + 'import"./ui-5.js";import"./three-7.js";\n');
    put(dist, 'assets/ui-5.js', 'const t="Loading three.js splat Splat Gaussian";\n');
    put(dist, 'assets/three-7.js', 'const q=1;\n');
    put(dist, 'assets/three-7.js.map', JSON.stringify({ sources: ['../node_modules/three/src/core/Object3D.js'] }));
    put(dist, 'assets/stray-9.js', 'const s=1;\n');
    const r = await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const d = JSON.parse(readFileSync(join(out, 'bundle_tower.json'), 'utf8'));
    const f = (n) => d.files.find((x) => x.path === `assets/${n}`);
    assert.deepEqual([f('ui-5.js').is_3d, f('ui-5.js').basis], [false, 'heuristic']);
    assert.deepEqual([f('three-7.js').is_3d, f('three-7.js').basis], [true, 'sourcemap']);
    assert.match(r[0].method, /3D basis: package 0, sourcemap 2, code-marker heuristic \d+ JS files/);
    assert.match(r[0].method, /WARNING: \d+ dist JS file\(s\) outside the entry closure.*stray-9\.js/);
    assert.ok(d.warnings.some((w) => /stray-9\.js/.test(w)));
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('dist: 깨진 sourcemap·sources 가 빈 맵은 앱 판정이 아니라 코드 표지 폴백으로 간다', async () => {
  const dist = mockDist();
  const out = mkdtempSync(join(tmpdir(), 'sky-out-'));
  try {
    put(dist, 'assets/control-G.js', FILES['control-G.js'] + 'import"./broken-1.js";import"./empty-2.js";import"./nonjson-3.js";import"./plain-4.js";\n');
    put(dist, 'assets/broken-1.js', 'const w=new WebGLRenderer();\n');
    put(dist, 'assets/broken-1.js.map', '{"version":3,"sources":[');
    put(dist, 'assets/empty-2.js', 'const g=new BufferGeometry();\n');
    put(dist, 'assets/empty-2.js.map', JSON.stringify({ version: 3, sources: [] }));
    put(dist, 'assets/nonjson-3.js', 'const g=new SplatMesh();\n');
    put(dist, 'assets/nonjson-3.js.map', JSON.stringify({ version: 3, sources: [1, null] }));
    put(dist, 'assets/plain-4.js', 'const t="three splat";\n');
    put(dist, 'assets/plain-4.js.map', '<html>404</html>');
    await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const d = JSON.parse(readFileSync(join(out, 'bundle_tower.json'), 'utf8'));
    const f = (n) => d.files.find((x) => x.path === `assets/${n}`);
    for (const n of ['broken-1.js', 'empty-2.js', 'nonjson-3.js']) assert.deepEqual([f(n).is_3d, f(n).basis], [true, 'heuristic'], n);
    assert.deepEqual([f('plain-4.js').is_3d, f('plain-4.js').basis], [false, 'heuristic']);
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

// 실제 develop vite dist(SKYLENS_DIR/dist)가 있을 때만: 못 푼 참조가 0 으로 method 에 기록돼야 한다.
const REAL_DIST = process.env.SKYLENS_DIR ? join(process.env.SKYLENS_DIR, 'dist') : null;
test('실제 dist: 못 푼 동적/mapDeps 참조가 0 으로 method 에 기록된다', { skip: !REAL_DIST || !existsSync(join(REAL_DIST, 'res', 'static', 'control.html')) }, async () => {
  const r = await run({ skylensDir: process.env.SKYLENS_DIR, commit: COMMIT, inputs: { distDir: REAL_DIST } });
  assert.match(r[0].method, /못 푼 동적\/mapDeps 참조 0개/);
});
