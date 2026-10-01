// 합성 점 파일(작은 점 수)로 자산 바이트 집계와 크기 검사를 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, checkPointFile, assertPointFile, LEVELS, POINT_BYTES } from './index.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const COMMIT = 'abcdef1234567';

async function fixture(counts, header = 0, extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asset_bytes-'));
  const assets = path.join(dir, 'assets');
  await mkdir(assets);
  for (const [seg, pts] of Object.entries(counts)) {
    for (const [i, level] of LEVELS.entries()) {
      await writeFile(path.join(assets, `seg${seg}_L${level}.bin`), Buffer.alloc(header + POINT_BYTES * pts[i]));
    }
  }
  for (const [name, size] of Object.entries(extra)) await writeFile(path.join(assets, name), Buffer.alloc(size));
  return { dir, assets };
}

test('27 B × 점 수 와 파일 크기 차 ≤ 헤더 크기', () => {
  for (const header of [0, 16]) {
    for (const n of [0, 1, 7, 100]) {
      const r = checkPointFile(header + POINT_BYTES * n, header);
      assert.ok(r.ok, r.errors.join());
      assert.equal(r.points, n);
      assert.ok(r.remainder <= header);
    }
  }
  assert.equal(assertPointFile(54), 2);
});

test('헤더 크기를 초과하는 손상 파일은 거부', () => {
  assert.equal(checkPointFile(28).ok, false); // 1 B 초과
  assert.equal(checkPointFile(26 + 27, 16).ok, false); // 본문 37 B, 나머지 10
  assert.equal(checkPointFile(16 + 27 * 3 + 1, 16).ok, false);
  assert.equal(checkPointFile(10, 16).ok, false); // 헤더보다 작음
  assert.equal(checkPointFile(-1).ok, false);
  assert.throws(() => assertPointFile(100, 0, 'seg0_L250.bin'), /seg0_L250\.bin/);
});

test('run: 구간별 4수준 합과 수준별 지표, assertRecords 통과', async () => {
  const { dir, assets } = await fixture({ 0: [1, 2, 3, 4], 1: [10, 20, 30, 40] }, 0, { 'notes.txt': 5 });
  try {
    const recs = await run({ skylensDir: dir, outDir: path.join(dir, 'out'), commit: COMMIT });
    assertRecords(recs);
    const tot = recs.filter((r) => r.metric === 'asset_bytes.segment_total');
    assert.deepEqual(tot.map((r) => r.value), [27 * 10, 27 * 100]);
    assert.ok(tot.every((r) => r.unit === 'B'));
    const l250 = recs.filter((r) => r.metric === 'asset_bytes.level_250').map((r) => r.value);
    assert.deepEqual(l250, [27, 270]);
    assert.equal(recs.find((r) => r.metric === 'asset_bytes.points_total').value, 110);
    assert.equal(recs.find((r) => r.metric === 'asset_bytes.segment_total_mean').value, 27 * 55);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'out', 'asset_bytes.json'), 'utf8')).length, recs.length);
    // assetsRoot 인자 지정
    assert.equal((await run({ skylensDir: '/nonexistent', assetsRoot: assets, commit: COMMIT })).length, recs.length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('run: 헤더 크기 인자 적용, 손상·누락은 거부', async () => {
  const ok = await fixture({ 0: [1, 1, 1, 1] }, 8);
  const bad = await fixture({ 0: [1, 1, 1, 1] }, 0, { 'seg0_L250.bin': 40 });
  const miss = await fixture({ 0: [1, 1, 1, 1] });
  try {
    const recs = await run({ skylensDir: ok.dir, commit: COMMIT, headerSize: 8 });
    assert.equal(recs.find((r) => r.metric === 'asset_bytes.segment_total').value, 4 * 35);
    await assert.rejects(run({ skylensDir: ok.dir, commit: COMMIT }), /seg0_L/); // 헤더 0 이면 8 B 초과
    await assert.rejects(run({ skylensDir: bad.dir, commit: COMMIT }), /seg0_L250\.bin/);
    await rm(path.join(miss.assets, 'seg0_L7000.bin'));
    await assert.rejects(run({ skylensDir: miss.dir, commit: COMMIT }), /수준 7000/);
  } finally { for (const f of [ok, bad, miss]) await rm(f.dir, { recursive: true, force: true }); }
});
