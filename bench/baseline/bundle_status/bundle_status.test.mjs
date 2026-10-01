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

async function mockDist() {
  const d = await mkdtemp(join(tmpdir(), 'skylens-dist-'));
  await put(d, 'assets/three-AAA.js', THREE);
  await put(d, 'assets/gaussian-splats-3d-BBB.js', SPLATS);
  await put(d, 'assets/statusview-CCC.js', VIEW);
  await put(d, 'assets/unrelated-DDD.js', 'zzzzzzz\n'.repeat(999));
  await put(d, 'assets/three-AAA.js.map', 'm'.repeat(5000));
  return d;
}

const val = (recs, m) => recs.find((r) => r.metric === m).value;

test('dist: gzip/raw 바이트가 박아 둔 숫자와 같다', async () => {
  const dist = await mockDist();
  try {
    const r = await run({ skylensDir: '/nonexistent', outDir: null, commit: COMMIT, inputs: { distDir: dist } });
    assertRecords(r);
    assert.equal(val(r, 'bundle_status.gzip_bytes'), 138);
    assert.equal(val(r, 'bundle_status.raw_bytes'), 8000);
    assert.equal(val(r, 'bundle_status.three.gzip_bytes'), 50);
    assert.equal(val(r, 'bundle_status.splats.gzip_bytes'), 47);
    assert.equal(val(r, 'bundle_status.statusview.gzip_bytes'), 41);
    assert.match(r[0].method, /dist/);
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

test('대상 0개: 관련 청크 없는 dist 는 reject', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'skylens-empty-'));
  try {
    await put(dist, 'assets/unrelated-DDD.js', 'q'.repeat(100));
    await assert.rejects(run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs: { distDir: dist } }), /측정 대상/);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('distDir 없으면 빌드 필요로 reject, distDir 가 없는 경로면 reject', async () => {
  await assert.rejects(run({ skylensDir: '/nonexistent', outDir: null, commit: COMMIT }), /dist 가 필요/);
  await assert.rejects(run({ skylensDir: '/x', outDir: null, commit: COMMIT, inputs: { distDir: '/nonexistent/dist' } }), /distDir/);
});
