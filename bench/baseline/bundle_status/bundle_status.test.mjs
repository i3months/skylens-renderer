// bundle_status 측정 모듈 테스트. 모의 skylens 트리를 임시 디렉터리에 만들어 쓴다.
// SKYLENS_DIR 이 있으면 실제 트리도 함께 잰다. 없으면 모의 트리만으로 통과한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { run } from './index.mjs';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';

const COMMIT = 'abcdef1234567';
const blob = (seed, n) => Array.from({ length: n }, (_, i) => `var v${i}=${(i * seed) % 97};`).join('\n');

async function put(root, rel, text) {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, text);
}

async function mockDist() {
  const d = await mkdtemp(join(tmpdir(), 'skylens-dist-'));
  await put(d, 'dist/assets/three-AAA.js', blob(3, 400));
  await put(d, 'dist/assets/gaussian-splats-3d-BBB.js', blob(5, 300));
  await put(d, 'dist/assets/statusview-CCC.js', blob(7, 200));
  await put(d, 'dist/assets/unrelated-DDD.js', blob(11, 999));
  return d;
}

async function mockSource() {
  const d = await mkdtemp(join(tmpdir(), 'skylens-src-'));
  await put(d, 'src/skylens_client/statusview/view.js', blob(2, 100));
  await put(d, 'src/skylens_client/statusview/sub/util.js', blob(4, 50));
  await put(d, 'node_modules/three/build/three.module.js', blob(3, 400));
  await put(d, 'node_modules/three/examples/ignored.js', blob(9, 400));
  await put(d, 'node_modules/@mkkellogg/gaussian-splats-3d/build/gs3d.module.js', blob(5, 300));
  return d;
}

const val = (recs, m) => recs.find((r) => r.metric === m).value;

test('dist 빌드: 같은 입력을 두 번 재면 바이트가 같고 계약을 통과한다', async () => {
  const dir = await mockDist();
  const out = await mkdtemp(join(tmpdir(), 'skylens-out-'));
  try {
    const a = await run({ skylensDir: dir, outDir: out, commit: COMMIT });
    const b = await run({ skylensDir: dir, outDir: out, commit: COMMIT });
    assertRecords(a);
    assert.deepEqual(a, b);
    assert.equal(serialize(a), serialize(b));
    const total = val(a, 'bundle_status.gzip_bytes');
    assert.ok(total > 0);
    assert.equal(a[0].unit, 'B');
    // 무관한 청크는 제외되고, 합은 파일별 gzip level 9 크기의 합과 같다.
    let expected = 0;
    for (const f of ['three-AAA', 'gaussian-splats-3d-BBB', 'statusview-CCC']) {
      expected += gzipSync(await readFile(join(dir, `dist/assets/${f}.js`)), { level: 9 }).length;
    }
    assert.equal(total, expected);
    assert.equal(val(a, 'bundle_status.three.gzip_bytes') + val(a, 'bundle_status.splats.gzip_bytes') + val(a, 'bundle_status.statusview.gzip_bytes'), total);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('소스 대체 경로: dist 가 없으면 statusview 소스와 node_modules 패키지를 잰다', async () => {
  const dir = await mockSource();
  try {
    const a = await run({ skylensDir: dir, outDir: null, commit: COMMIT });
    const b = await run({ skylensDir: dir, outDir: null, commit: COMMIT });
    assertRecords(a);
    assert.deepEqual(a, b);
    assert.match(a[0].method, /source/);
    // three 는 build/ 만 센다(examples 제외).
    assert.equal(val(a, 'bundle_status.three.gzip_bytes'), gzipSync(await readFile(join(dir, 'node_modules/three/build/three.module.js')), { level: 9 }).length);
    assert.ok(val(a, 'bundle_status.statusview.gzip_bytes') > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('대상이 전혀 없으면 오류를 던진다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skylens-empty-'));
  try {
    await assert.rejects(run({ skylensDir: dir, outDir: null, commit: COMMIT }), /측정 대상이 없다/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SKYLENS_DIR 이 있으면 실제 트리도 결정적으로 잰다 (없으면 모의 트리로 대체)', async () => {
  const mock = process.env.SKYLENS_DIR ? null : await mockDist();
  const dir = process.env.SKYLENS_DIR || mock;
  try {
    const a = await run({ skylensDir: dir, outDir: null, commit: COMMIT });
    const b = await run({ skylensDir: dir, outDir: null, commit: COMMIT });
    assertRecords(a);
    assert.equal(val(a, 'bundle_status.gzip_bytes'), val(b, 'bundle_status.gzip_bytes'));
  } finally {
    if (mock) await rm(mock, { recursive: true, force: true });
  }
});
