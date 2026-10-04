// bundle_status 측정 테스트. 모의 dist 를 임시 디렉터리에 만들어 distDir 입력으로 넘긴다.
// 기준값(raw/gzip 바이트)은 고정 입력에서 독립적으로(python gzip -9) 구해 박았다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './index.mjs';
import { basisSummary, mapEvidence } from './closure.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const COMMIT = 'abcdef1234567';
const THREE = 'abcdefg\n'.repeat(500); // raw 4000, gzip 50
const VIEW = 'pqrstuv\n'.repeat(200); // raw 1600, gzip 41

async function put(root, rel, text) {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, text);
}


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
// 기대값: status = 공유(geo+math+deep+style) + status-A + side + status-D
const STATUS = { raw: 10241, gzip: 446 };

async function mockDist() {
  const d = await mkdtemp(join(tmpdir(), 'skylens-dist-'));
  for (const [n, t] of Object.entries(FILES)) await put(d, `assets/${n}`, t);
  await put(d, 'res/static/status.html', html('status-A.js', 'status-D.css'));
  await put(d, 'res/static/control.html', html('control-G.js', 'control-H.css'));
  await put(d, 'assets/math-C.js.map', JSON.stringify({ sources: ['../../node_modules/three/src/math/Matrix4.js'] }));
  return d;
}

const val = (recs, m) => recs.find((r) => r.metric === m).value;
const noMethod = ({ method, ...rest }) => rest;

test('dist: status.html 폐포의 raw/gzip 합이 박아 둔 숫자와 같다', async () => {
  const dist = await mockDist();
  try {
    const r = await run({ skylensDir: '/nonexistent', outDir: null, commit: COMMIT, inputs: { distDir: dist } });
    assertRecords(r);
    assert.equal(val(r, 'bundle_status.gzip_bytes'), STATUS.gzip);
    assert.equal(val(r, 'bundle_status.raw_bytes'), STATUS.raw);
    assert.equal(val(r, 'bundle_status.3d.gzip_bytes'), 84);
    assert.equal(val(r, 'bundle_status.3d.raw_bytes'), 5622);
    assert.ok(val(r, 'bundle_status.3d.gzip_bytes') < val(r, 'bundle_status.gzip_bytes'));
    assert.match(r[0].method, /sourcemap/);
    assert.match(r[0].method, /dist/);
    assert.match(r[0].method, /shared chunks/);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('무관 청크·변형·동적 import 대상을 추가해도 값 불변', async () => {
  const dist = await mockDist();
  try {
    const inputs = { distDir: dist };
    const a = await run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs });
    await put(dist, 'assets/three-ZZ.js', 'k'.repeat(9000));
    await put(dist, 'assets/gaussian-splats-3d-QQ.js', 'k'.repeat(9000));
    await put(dist, 'assets/statusview-RR.js', 'k'.repeat(9000));
    await put(dist, 'assets/drone-Z.js', 'k'.repeat(9000));
    await put(dist, 'assets/unrelated-C.js.map', 'm'.repeat(9000));
    assert.deepEqual((await run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs })).map(noMethod), a.map(noMethod)); // method 에는 폐포 밖 JS 경고가 붙으므로 method 만 뺀 나머지 필드를 모두 비교한다
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('dist: 3D 합계에 CSS 가 0개이고 3D 표지 없는 청크는 빠진다', async () => {
  const dist = await mockDist();
  const out = await mkdtemp(join(tmpdir(), 'skylens-out-'));
  try {
    await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const m = JSON.parse(await readFile(join(out, 'bundle_status.manifest.json'), 'utf8')).manifest;
    const t = m.filter((f) => f.is_3d);
    assert.deepEqual(t.map((f) => f.file), ['assets/math-C.js']);
    assert.equal(t.filter((f) => f.file.endsWith('.css')).length, 0);
    assert.ok(m.some((f) => f.file.endsWith('.css')));
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('dist: 동적 import() 와 mapDeps 청크가 폐포·3D 합계에 들어간다', async () => {
  const dist = await mockDist();
  try {
    const inputs = { distDir: dist };
    const a = await run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs });
    await put(dist, 'assets/status-A.js', FILES['status-A.js'] + 'const l=()=>import("./lazy-3d.js");const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/map-3d.js","assets/map.css"])))=>i.map(i=>d[i]);\n');
    await put(dist, 'assets/lazy-3d.js', 'new WebGLRenderer();\n'.repeat(100));
    await put(dist, 'assets/map-3d.js', 'class SplatMesh{}\n'.repeat(100));
    await put(dist, 'assets/map.css', '.q{top:0}\n'.repeat(30));
    const b = await run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs });
    assert.ok(val(b, 'bundle_status.raw_bytes') > val(a, 'bundle_status.raw_bytes') + 3000);
    assert.ok(val(b, 'bundle_status.3d.raw_bytes') >= val(a, 'bundle_status.3d.raw_bytes') + 3500);
    assert.ok(val(b, 'bundle_status.3d.gzip_bytes') < val(b, 'bundle_status.gzip_bytes'));
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('같은 dist 를 두 번 재면 같다(빌드 재현성이 아니라 같은 dist 재계측)', async () => {
  const dist = await mockDist();
  try {
    const inputs = { distDir: dist };
    const a = await run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs });
    const b = await run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs });
    assert.deepEqual(a, b);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

// 소스 모드(opt-in): three 의 build/ 에 변형을 추가해도 진입점 하나만 재므로 값이 불변이다.
test('source: cjs·min·webgpu 변형을 추가해도 값 불변, 진입점 하나만', async () => {
  const d = await mkdtemp(join(tmpdir(), 'skylens-src-'));
  try {
    await put(d, 'src/skylens_client/statusview/view.js', VIEW);
    await put(d, 'node_modules/three/package.json', JSON.stringify({ exports: { '.': { import: './build/three.module.js', require: './build/three.cjs' } } }));
    await put(d, 'node_modules/three/build/three.module.js', THREE);
    const inputs = { allowSource: true };
    const a = await run({ skylensDir: d, outDir: null, commit: COMMIT, inputs });
    assert.equal(val(a, 'bundle_status.three.gzip_bytes'), 50);
    assert.equal(val(a, 'bundle_status.raw_bytes'), 5600);
    assert.equal(val(a, 'bundle_status.3d.gzip_bytes'), 50);
    await put(d, 'node_modules/three/build/three.cjs', 'c'.repeat(9000));
    await put(d, 'node_modules/three/build/three.min.js', 'm'.repeat(9000));
    await put(d, 'node_modules/three/build/three.webgpu.js', 'w'.repeat(9000));
    await put(d, 'node_modules/three/build/three.webgpu.min.js', 'v'.repeat(9000));
    const b = await run({ skylensDir: d, outDir: null, commit: COMMIT, inputs });
    assert.deepEqual(b, a);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('source: three.module.js 가 import 하는 three.core.js 가 포함된다', async () => {
  const d = await mkdtemp(join(tmpdir(), 'skylens-src-'));
  try {
    await put(d, 'node_modules/three/package.json', JSON.stringify({ exports: { '.': { import: './build/three.module.js' } } }));
    await put(d, 'node_modules/three/build/three.module.js', "export * from './three.core.js';\n" + THREE);
    await put(d, 'node_modules/three/build/three.core.js', 'core-body-aa\n'.repeat(300));
    const inputs = { allowSource: true };
    const a = await run({ skylensDir: d, outDir: null, commit: COMMIT, inputs });
    assert.equal(val(a, 'bundle_status.raw_bytes'), 4000 + 33 + 3900);
    assert.ok(val(a, 'bundle_status.three.gzip_bytes') > 50);
    assert.equal(val(a, 'bundle_status.3d.gzip_bytes'), val(a, 'bundle_status.three.gzip_bytes'));
    assert.deepEqual(await run({ skylensDir: d, outDir: null, commit: COMMIT, inputs }), a);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('진입 HTML 이 없으면 reject, 참조 파일이 없어도 reject', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'skylens-empty-'));
  try {
    await put(dist, 'assets/three-AA.js', 'q'.repeat(100));
    await assert.rejects(run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs: { distDir: dist } }), /진입 HTML/);
    await put(dist, 'res/static/status.html', html('status-A.js', 'status-D.css'));
    await assert.rejects(run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs: { distDir: dist } }), /status-A\.js/);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('distDir 없으면 빌드 필요로 reject, distDir 가 없는 경로면 reject', async () => {
  await assert.rejects(run({ skylensDir: '/nonexistent', outDir: null, commit: COMMIT }), /dist 가 필요/);
  await assert.rejects(run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs: { distDir: '/nonexistent/dist' } }), /distDir/);
});

// 하위 디렉터리 진입 HTML 픽스처: res/static/status.html 이 res/static/assets/ 의 청크를 참조한다.
const SUB_ENTRY = [
  'import("./c1.js",{with:{}});',
  'const b=()=>import(`./c2.js`);',
  'const u=new URL("./c3.js",import.meta.url);',
  'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/three-a.js","assets/gone.js"])))=>i.map(i=>d[i]);',
].join('\n') + '\n';

async function subDist(entry = SUB_ENTRY) {
  const d = await mkdtemp(join(tmpdir(), 'skylens-sub-'));
  await put(d, 'res/static/status.html', '<!doctype html><script type="module" src="./assets/entry.js"></script>');
  await put(d, 'res/static/assets/entry.js', entry);
  await put(d, 'res/static/assets/three-a.js', 'const q=1;\n'.repeat(50));
  await put(d, 'res/static/assets/c1.js', 'export const c1=1;\n');
  await put(d, 'res/static/assets/c2.js', 'export const c2=1;\n');
  await put(d, 'res/static/assets/c3.js', 'export const c3=1;\n');
  await put(d, 'res/static/assets/stray.js', 'export const z=1;\n');
  await put(d, 'res/static/assets/three-a.js.map', JSON.stringify({ sources: ['../../node_modules/three/src/core/Object3D.js'] }));
  return d;
}

test('dist: 진입 HTML 이 하위 디렉터리여도 mapDeps·동적 import 3형태가 폐포에 들어가고 못 푼 참조는 method 에 기록된다', async () => {
  const dist = await subDist();
  const out = await mkdtemp(join(tmpdir(), 'skylens-out-'));
  try {
    const r = await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const j = JSON.parse(await readFile(join(out, 'bundle_status.manifest.json'), 'utf8'));
    const files = j.manifest.map((f) => f.file);
    for (const n of ['entry', 'three-a', 'c1', 'c2', 'c3']) assert.ok(files.includes(`res/static/assets/${n}.js`), n);
    assert.equal(j.manifest.find((f) => f.file.endsWith('three-a.js')).is_3d, true);
    assert.match(r[0].method, /unresolved dynamic\/mapDeps refs: 1 \(WARNING.*assets\/gone\.js/);
    assert.deepEqual(j.unresolved.map((u) => u.spec), ['assets/gone.js']);
    assert.deepEqual(j.outside_closure_js, ['res/static/assets/stray.js']);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('dist: 못 푼 참조가 없으면 method 에 0 으로 기록된다', async () => {
  const dist = await subDist(SUB_ENTRY.replace(',"assets/gone.js"', ''));
  try {
    const r = await run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs: { distDir: dist } });
    assert.match(r[0].method, /unresolved dynamic\/mapDeps refs: 0(?:;|$)/);
    assert.doesNotMatch(r[0].method, /WARNING: 3D total may be understated/);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('dist: CSS 에 3D 표지 문구가 있어도 3D 합계에서 빠지고, webgl2 백틱·webgpu·sourcemap 은 3D 로 잡힌다', async () => {
  const dist = await mockDist();
  const out = await mkdtemp(join(tmpdir(), 'skylens-out-'));
  try {
    await put(dist, 'assets/status-A.js', FILES['status-A.js'] + 'import"./gl-2.js";import"./gpu-3.js";import"./mapped-4.js";\n');
    await put(dist, 'assets/gl-2.js', 'const c=el.getContext(`webgl2`);\n');
    await put(dist, 'assets/gpu-3.js', 'const c=el.getContext("webgpu");\n');
    await put(dist, 'assets/mapped-4.js', 'const m=1;\n');
    await put(dist, 'assets/mapped-4.js.map', JSON.stringify({ sources: ['../node_modules/@mkkellogg/gaussian-splats-3d/src/Viewer.js'] }));
    await put(dist, 'assets/status-D.css', '/* three splat Gaussian WebGLRenderer BufferGeometry Matrix4 */\n.a{color:red}\n');
    await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const m = JSON.parse(await readFile(join(out, 'bundle_status.manifest.json'), 'utf8')).manifest;
    assert.equal(m.find((f) => f.file === 'assets/status-D.css').is_3d, false);
    assert.deepEqual(m.filter((f) => f.is_3d).map((f) => f.file), ['assets/gl-2.js', 'assets/gpu-3.js', 'assets/mapped-4.js', 'assets/math-C.js']);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('dist: 문구에 three·Splat 만 있는 앱 청크는 3D 가 아니고, sourcemap 이 앱 소스면 표지가 있어도 3D 가 아니다', async () => {
  const dist = await mockDist();
  const out = await mkdtemp(join(tmpdir(), 'skylens-out-'));
  try {
    await put(dist, 'assets/status-A.js', FILES['status-A.js'] + 'import"./ui-5.js";import"./lib-6.js";import"./three-7.js";\n');
    await put(dist, 'assets/ui-5.js', 'const t="Loading three.js splat Splat Gaussian view";const THREE_LABEL=\'three\';\n');
    await put(dist, 'assets/lib-6.js', 'const w=new WebGLRenderer();\n');
    await put(dist, 'assets/lib-6.js.map', JSON.stringify({ sources: ['../src/app/lib.js'] }));
    await put(dist, 'assets/three-7.js', 'const q=1;\n');
    await put(dist, 'assets/three-7.js.map', JSON.stringify({ sources: ['..\\node_modules\\three\\src\\core\\Object3D.js'] }));
    const r = await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const m = JSON.parse(await readFile(join(out, 'bundle_status.manifest.json'), 'utf8')).manifest;
    const f = (n) => m.find((x) => x.file === `assets/${n}`);
    assert.deepEqual([f('ui-5.js').is_3d, f('ui-5.js').basis], [false, 'heuristic']);
    assert.deepEqual([f('lib-6.js').is_3d, f('lib-6.js').basis], [false, 'sourcemap']);
    assert.deepEqual([f('three-7.js').is_3d, f('three-7.js').basis], [true, 'sourcemap']);
    assert.deepEqual([f('math-C.js').is_3d, f('math-C.js').basis], [true, 'sourcemap']);
    assert.match(r[0].method, /3D basis: package 0, sourcemap 3, code-marker heuristic \d+ JS files/);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('dist: 깨진 sourcemap·sources 가 빈 맵은 앱 판정이 아니라 코드 표지 폴백으로 간다', async () => {
  const dist = await mockDist();
  const out = await mkdtemp(join(tmpdir(), 'skylens-out-'));
  try {
    await put(dist, 'assets/status-A.js', FILES['status-A.js'] + 'import"./broken-1.js";import"./empty-2.js";import"./nonjson-3.js";import"./plain-4.js";import"./html-5.js";\n');
    await put(dist, 'assets/broken-1.js', 'const w=new WebGLRenderer();\n');
    await put(dist, 'assets/broken-1.js.map', '{"version":3,"sources":[');
    await put(dist, 'assets/empty-2.js', 'const g=new BufferGeometry();\n');
    await put(dist, 'assets/empty-2.js.map', JSON.stringify({ version: 3, sources: [] }));
    await put(dist, 'assets/nonjson-3.js', 'const g=new SplatMesh();\n');
    await put(dist, 'assets/nonjson-3.js.map', JSON.stringify({ version: 3, sources: [1, null] }));
    await put(dist, 'assets/plain-4.js', 'const t="three splat";\n');
    // plain-4.js 는 .map 파일 없음 (맵 파일이 없으면 null 반환)
    await put(dist, 'assets/html-5.js', 'const t="three splat";\n');
    await put(dist, 'assets/html-5.js.map', '<html>404</html>');
    await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const m = JSON.parse(await readFile(join(out, 'bundle_status.manifest.json'), 'utf8')).manifest;
    const f = (n) => m.find((x) => x.file === `assets/${n}`);
    // JSON 파싱 실패: parse error basis로 폴백하되 is_3d 는 코드 표지로 판정
    assert.ok(f('broken-1.js').is_3d === true && f('broken-1.js').basis.startsWith('sourcemap-parse-error:'), 'broken-1.js');
    // sources 빔: 코드 표지 폴백
    assert.deepEqual([f('empty-2.js').is_3d, f('empty-2.js').basis], [true, 'heuristic']);
    // sources에 문자열 아닌 항목: 코드 표지 폴백
    assert.deepEqual([f('nonjson-3.js').is_3d, f('nonjson-3.js').basis], [true, 'heuristic']);
    // 맵 파일 없음: 코드 표지 폴백
    assert.deepEqual([f('plain-4.js').is_3d, f('plain-4.js').basis], [false, 'heuristic']);
    // HTML 이 맵 자리에 온 경우: parse error basis, is_3d 는 코드 표지(문자열 three splat 은 표지 아님 → false)로 판정
    assert.ok(f('html-5.js').basis.startsWith('sourcemap-parse-error:'), 'html-5.js basis');
    assert.equal(f('html-5.js').is_3d, false);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('mapEvidence: BOM 붙은 맵은 파싱되고, 내용이 null 인 맵은 parse error 가 아니다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skylens-map-'));
  try {
    await put(dir, 'bom.js.map', '\uFEFF' + JSON.stringify({ version: 3, sources: ['../node_modules/three/src/core/Object3D.js'] }));
    assert.equal(mapEvidence(join(dir, 'bom.js')), 'sourcemap-3d');
    await put(dir, 'nul.js.map', 'null');
    assert.equal(mapEvidence(join(dir, 'nul.js')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('basisSummary: 근거가 전부 parse error 여도 휴리스틱 경고 문구가 붙는다', () => {
  const m = basisSummary(['sourcemap-parse-error:Unexpected end']);
  assert.ok(m.includes('(no usable sourcemap; heuristic may misclassify)'), m);
  assert.ok(m.includes('1 sourcemap parse error(s)'), m);
});

test('dist: 폐포 밖 JS 가 있으면 경고가 method 와 manifest 에 남는다', async () => {
  const dist = await mockDist();
  const out = await mkdtemp(join(tmpdir(), 'skylens-out-'));
  try {
    await put(dist, 'assets/stray-9.js', 'new WebGLRenderer();\n');
    const r = await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    assert.match(r[0].method, /WARNING: \d+ dist JS file\(s\) outside the entry closure.*assets\/stray-9\.js/);
    const j = JSON.parse(await readFile(join(out, 'bundle_status.manifest.json'), 'utf8'));
    assert.ok(j.warnings.some((w) => /stray-9\.js/.test(w)));
    assert.ok(j.outside_closure_js.includes('assets/stray-9.js'));
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

// 실제 develop vite dist(SKYLENS_DIR/dist)가 있을 때만: 못 푼 참조가 0 으로 method 에 기록돼야 한다.
const REAL_DIST = process.env.SKYLENS_DIR ? join(process.env.SKYLENS_DIR, 'dist') : null;
test('실제 dist: 못 푼 동적/mapDeps 참조가 0 으로 method 에 기록된다', { skip: (!REAL_DIST || !existsSync(join(REAL_DIST, 'res', 'static', 'status.html'))) ? 'REAL_DIST' : false }, async () => {
  const r = await run({ skylensDir: process.env.SKYLENS_DIR, outDir: null, commit: COMMIT, inputs: { distDir: REAL_DIST } });
  assert.match(r[0].method, /unresolved dynamic\/mapDeps refs: 0(?:;|$)/);
});

test('dist: sources 경로에 ] 가 있어도 sourcemap 으로 3D 판정된다', async () => {
  const dist = await mockDist();
  const out = await mkdtemp(join(tmpdir(), 'skylens-out-'));
  try {
    await put(dist, 'assets/status-A.js', FILES['status-A.js'] + 'import"./bracket-5.js";\n');
    await put(dist, 'assets/bracket-5.js', 'const a=1;\n');
    await put(dist, 'assets/bracket-5.js.map', JSON.stringify({ version: 3, sources: ['webpack:///./pages/[id].js', 'node_modules/three/build/three.module.js'] }));
    await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const m = JSON.parse(await readFile(join(out, 'bundle_status.manifest.json'), 'utf8')).manifest;
    const e = m.find((x) => x.file === 'assets/bracket-5.js');
    assert.deepEqual([e.is_3d, e.basis], [true, 'sourcemap']);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('dist: sourcemap JSON 파싱 실패하면 오류가 basis 와 method 에 기록된다', async () => {
  const dist = await mockDist();
  const out = await mkdtemp(join(tmpdir(), 'skylens-out-'));
  try {
    await put(dist, 'assets/status-A.js', FILES['status-A.js'] + 'import"./badjson-6.js";\n');
    await put(dist, 'assets/badjson-6.js', 'new WebGLRenderer();\n');
    await put(dist, 'assets/badjson-6.js.map', '{broken json no closing');
    const r = await run({ skylensDir: '/x', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    const m = JSON.parse(await readFile(join(out, 'bundle_status.manifest.json'), 'utf8')).manifest;
    const e = m.find((x) => x.file === 'assets/badjson-6.js');
    assert.ok(typeof e.basis === 'string');
    assert.ok(e.basis.startsWith('sourcemap-parse-error:'));
    assert.match(r[0].method, /sourcemap parse error\(s\):/);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});
