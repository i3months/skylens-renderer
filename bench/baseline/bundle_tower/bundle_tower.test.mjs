// bundle_tower 측정 테스트. 모의 dist 를 distDir 로 넘긴다. 기준값은 독립 계산(python gzip -9)한 고정 숫자.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

function mockDist() {
  const root = mkdtempSync(join(tmpdir(), 'sky-dist-'));
  put(root, 'assets/three-1a2b.js', THREE);
  put(root, 'assets/controlview-9f.js', CTRL);
  put(root, 'assets/terrain-loader-2c.js', LOADER);
  put(root, 'assets/app-77.js', 'u'.repeat(900));
  put(root, 'index.html', '<html></html>');
  return root;
}

test('dist: gzip/raw 바이트가 박아 둔 숫자와 같고 관련 청크만 합산', async () => {
  const dist = mockDist();
  const out = mkdtempSync(join(tmpdir(), 'sky-out-'));
  try {
    const r = await run({ skylensDir: '/nonexistent', outDir: out, commit: COMMIT, inputs: { distDir: dist } });
    assert.equal(val(r, 'bundle_tower.gzip_bytes'), 129);
    assert.equal(val(r, 'bundle_tower.raw_bytes'), 6800);
    assert.equal(r[0].unit, 'B');
    const d = JSON.parse(readFileSync(join(out, 'bundle_tower.json'), 'utf8'));
    assert.deepEqual(d.files.map((f) => f.path), ['assets/controlview-9f.js', 'assets/terrain-loader-2c.js', 'assets/three-1a2b.js']);
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
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

test('source(opt-in): three 변형(cjs·min·webgpu)을 추가해도 값 불변', async () => {
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
    for (const n of ['three.cjs', 'three.min.js', 'three.webgpu.js', 'three.webgpu.min.js', 'three.core.js']) {
      put(root, `node_modules/three/build/${n}`, 'k'.repeat(7000));
    }
    assert.deepEqual(await run({ skylensDir: root, commit: COMMIT, inputs }), a);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('대상 0개 → reject, distDir 없음 → 빌드 필요로 reject', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'sky-empty-'));
  try {
    put(dist, 'assets/app-77.js', 'u'.repeat(100));
    await assert.rejects(run({ skylensDir: '/x', commit: COMMIT, inputs: { distDir: dist } }), /측정 대상/);
    await assert.rejects(run({ skylensDir: '/nonexistent', commit: COMMIT }), /dist 가 필요/);
    await assert.rejects(run({ skylensDir: '/nonexistent', commit: COMMIT, inputs: { allowSource: true } }), /측정 대상/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('run 이 assertRecords 를 호출한다: 잘못된 commit 은 reject', async () => {
  const dist = mockDist();
  try {
    await assert.rejects(run({ skylensDir: '/x', commit: 'not-a-hash', inputs: { distDir: dist } }), /record 0/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
