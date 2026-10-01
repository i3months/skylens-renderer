// bundle_tower 측정 테스트. 임시 디렉터리의 모의 skylens 트리를 사용한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { run } from './index.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const COMMIT = 'abc1234';
const put = (root, rel, text) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const blob = (seed, n) => Array.from({ length: n }, (_, i) => `v${(i * seed) % 97}=${i};`).join('\n');

function mockSource() {
  const root = mkdtempSync(join(tmpdir(), 'sky-src-'));
  put(root, 'src/skylens_core/controlview/scene.js', blob(3, 400));
  put(root, 'src/skylens_core/controlview/sub/camera.ts', blob(5, 300));
  put(root, 'src/loaders/terrainLoader.js', blob(7, 200));
  put(root, 'src/loaders/buildingLoader.js', blob(11, 200));
  put(root, 'src/unrelated/ui.js', blob(13, 500));
  put(root, 'node_modules/three/build/three.module.js', blob(17, 800));
  put(root, 'node_modules/other/index.js', blob(19, 800));
  return root;
}

function mockDist() {
  const root = mkdtempSync(join(tmpdir(), 'sky-dist-'));
  put(root, 'dist/assets/three-1a2b.js', blob(3, 800));
  put(root, 'dist/assets/controlview-9f.js', blob(5, 400));
  put(root, 'dist/assets/terrain-loader-2c.js', blob(7, 200));
  put(root, 'dist/assets/app-77.js', blob(9, 900));
  put(root, 'dist/index.html', '<html></html>');
  return root;
}

test('source 모드: 같은 입력 두 번 측정 바이트 동일, 계약 통과', async () => {
  const root = mockSource();
  try {
    const a = await run({ skylensDir: root, outDir: join(root, 'o1'), commit: COMMIT });
    const b = await run({ skylensDir: root, outDir: join(root, 'o2'), commit: COMMIT });
    assertRecords(a);
    assert.equal(a.length, 1);
    assert.equal(a[0].metric, 'bundle_tower.gzip_bytes');
    assert.equal(a[0].unit, 'B');
    assert.ok(a[0].value > 0);
    assert.equal(a[0].value, b[0].value);
    assert.deepEqual(a, b);
    const d = JSON.parse(readFileSync(join(root, 'o1', 'bundle_tower.json'), 'utf8'));
    const names = d.files.map((f) => f.path);
    assert.equal(names.length, 5);
    assert.ok(!names.some((n) => n.includes('ui.js') || n.includes('other')));
    assert.equal(d.total, a[0].value);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dist 모드: 관련 청크만 합산, 결정적', async () => {
  const root = mockDist();
  try {
    const a = await run({ skylensDir: root, outDir: join(root, 'o'), commit: COMMIT });
    const b = await run({ skylensDir: root, commit: COMMIT });
    assertRecords(a);
    assert.equal(a[0].value, b[0].value);
    const d = JSON.parse(readFileSync(join(root, 'o', 'bundle_tower.json'), 'utf8'));
    assert.equal(d.mode, 'dist');
    assert.deepEqual(d.files.map((f) => f.path).sort(), [
      'dist/assets/controlview-9f.js',
      'dist/assets/terrain-loader-2c.js',
      'dist/assets/three-1a2b.js',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('관련 파일이 커지면 값이 증가한다', async () => {
  const root = mockSource();
  try {
    const a = await run({ skylensDir: root, commit: COMMIT });
    put(root, 'src/skylens_core/controlview/extra.js', blob(23, 600));
    const b = await run({ skylensDir: root, commit: COMMIT });
    assert.ok(b[0].value > a[0].value);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
