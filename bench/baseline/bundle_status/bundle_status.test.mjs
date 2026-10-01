// bundle_status 측정 테스트. 모의 dist 를 임시 디렉터리에 만들어 distDir 입력으로 넘긴다.
// 기준값(raw/gzip 바이트)은 고정 입력에서 독립적으로(python gzip -9) 구해 박았다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './index.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const COMMIT = 'abcdef1234567';
const THREE = 'abcdefg\n'.repeat(500); // raw 4000, gzip 50
const SPLATS = 'hijklmn\n'.repeat(300); // raw 2400, gzip 47
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
// 기대값: status = 공유(geo+math+deep+style) + status-A + side + status-D, tower = 공유 + control-G + control-H
const STATUS = { raw: 10241, gzip: 446 };
const TOWER = { raw: 9380, gzip: 387 };

async function mockDist() {
  const d = await mkdtemp(join(tmpdir(), 'skylens-dist-'));
  for (const [n, t] of Object.entries(FILES)) await put(d, `assets/${n}`, t);
  await put(d, 'res/static/status.html', html('status-A.js', 'status-D.css'));
  await put(d, 'res/static/control.html', html('control-G.js', 'control-H.css'));
  return d;
}

const val = (recs, m) => recs.find((r) => r.metric === m).value;

test('dist: status.html 폐포의 raw/gzip 합이 박아 둔 숫자와 같다', async () => {
  const dist = await mockDist();
  try {
    const r = await run({ skylensDir: '/nonexistent', outDir: null, commit: COMMIT, inputs: { distDir: dist } });
    assertRecords(r);
    assert.equal(val(r, 'bundle_status.gzip_bytes'), STATUS.gzip);
    assert.equal(val(r, 'bundle_status.raw_bytes'), STATUS.raw);
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
    await put(dist, 'assets/math-C.js.map', 'm'.repeat(9000));
    assert.deepEqual(await run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs }), a);
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
