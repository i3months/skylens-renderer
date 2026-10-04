// F-187 ①: fixtures/scenes 의 실제 .skla 조각 카탈로그로 buildInitialBundle 을 시험한다.
// 상한은 SPEC 의 15 MB = 15,000,000 B(MiB 아님). 소스 상수가 15 MiB 이면 large 장면에서 이 시험이 실패해야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInitialBundle } from './index.mjs';
import { buildSceneCatalog, loadViewpoints, poseOfViewpoint } from './testing/scene_catalog.testutil.mjs';

const LIMIT = 15_000_000;

// 장면별 고정 수치(seed 1, 생성기 기본 점 수). totals/dropped 는 synthetic.json 시점 1..8 순서.
const EXPECT = {
  flat_boxes: { points: 200000, chunks: 16, sklaBytes: 2202216, level0Bytes: 2202216,
    totals: [2202216, 2202216, 2202216, 2104204, 1801112, 2104204, 2152996, 2202216],
    dropped: [0, 0, 0, 0, 0, 0, 0, 0] },
  terrain: { points: 200000, chunks: 16, sklaBytes: 2202196, level0Bytes: 2202196,
    totals: [2202196, 2202196, 2202196, 2058424, 1679300, 2058424, 2058424, 2202196],
    dropped: [0, 0, 0, 0, 0, 0, 0, 0] },
  holes: { points: 100000, chunks: 16, sklaBytes: 1102204, level0Bytes: 1102204,
    totals: [1102204, 1102204, 1102204, 1026324, 764696, 1026324, 1064368, 1102204],
    dropped: [0, 0, 0, 0, 0, 0, 0, 0] },
  levels: { points: 160000, chunks: 112, sklaBytes: 3315560, level0Bytes: 223956,
    totals: [123236, 71752, 139760, 69980, 45816, 69980, 223956, 223956],
    dropped: [0, 0, 0, 0, 0, 0, 0, 0] },
  large: { points: 2500000, chunks: 64, sklaBytes: 27508808, level0Bytes: 27508808,
    totals: [14704244, 14943940, 14873236, 14901260, 12158704, 14824612, 14412368, 14943576],
    dropped: [11, 2, 19, 2, 0, 0, 0, 2] },
  depth_noise: { points: 200000, chunks: 5, sklaBytes: 2200672, level0Bytes: 2200672,
    totals: [2200672, 2200672, 2200672, 2200672, 2200672, 2200672, 2200672, 2200672],
    dropped: [0, 0, 0, 0, 0, 0, 0, 0] },
  buildings: { points: 1000, chunks: 866, sklaBytes: 138656, level0Bytes: 138656,
    totals: [28000, 38116, 3360, 38572, 35556, 10400, 34880, 38720],
    dropped: [0, 0, 0, 0, 0, 0, 0, 0] },
  dem: { points: 16641, chunks: 441, sklaBytes: 243200, level0Bytes: 243200,
    totals: [75992, 78732, 17756, 84460, 76308, 38540, 76472, 87688],
    dropped: [0, 0, 0, 0, 0, 0, 0, 0] },
};

const vps = loadViewpoints();
const rows = [];

// 사원수로 회전한 (0,0,1) — index.mjs 의 forwardOf 와 같은 식(시험용 독립 계산)
const fwdOfQuat = ([x, y, z, w]) => [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];

test('시점 pose: 사원수의 앞 방향이 eye→target 과 같다', () => {
  assert.equal(vps.length, 8);
  for (const vp of vps) {
    const p = poseOfViewpoint(vp);
    const f = fwdOfQuat(p.quat);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(f[i] - p.forward[i]) < 1e-9, `${vp.name}`);
    assert.ok(Math.abs(Math.hypot(...p.quat) - 1) < 1e-9);
  }
});

for (const [name, want] of Object.entries(EXPECT)) {
  test(`장면 ${name}: 조각 크기·초기 묶음 수치 고정, totalBytes <= 15,000,000`, async () => {
    const c = await buildSceneCatalog(name);
    assert.deepEqual(
      { points: c.pointCount, chunks: c.catalog.length, sklaBytes: c.totalSklaBytes, level0Bytes: c.level0Bytes },
      { points: want.points, chunks: want.chunks, sklaBytes: want.sklaBytes, level0Bytes: want.level0Bytes });
    // 결정성: 한 번 더 만들어도 같은 크기
    assert.equal((await buildSceneCatalog(name)).totalSklaBytes, want.sklaBytes);

    const totals = [], dropped = [];
    for (const vp of vps) {
      const r = buildInitialBundle({ pose: poseOfViewpoint(vp), catalog: c.catalog }); // 예산은 소스 기본값
      assert.ok(r.totalBytes <= LIMIT, `${name}/${vp.name}: totalBytes ${r.totalBytes} > ${LIMIT}`);
      assert.ok(r.frameBytes <= LIMIT, `${name}/${vp.name}: frameBytes ${r.frameBytes} > ${LIMIT}`);
      assert.equal(r.totalBytes, r.items.reduce((s, it) => s + it.bytes, 0));
      totals.push(r.totalBytes);
      dropped.push(r.droppedCount);
    }
    rows.push({ scene: name, points: c.pointCount, sklaBytes: c.totalSklaBytes, level0Bytes: c.level0Bytes,
      maxTotal: Math.max(...totals), droppedSum: dropped.reduce((a, b) => a + b, 0) });
    assert.deepEqual(totals, want.totals);
    assert.deepEqual(dropped, want.dropped);
  });
}

test('large: 레벨 0 합이 15,000,000 B 초과인 합성 대형 장면에서 droppedCount > 0 이고 totalBytes <= 15,000,000', async () => {
  const c = await buildSceneCatalog('large');
  assert.ok(c.level0Bytes > LIMIT, `level0 ${c.level0Bytes}`);
  const r = buildInitialBundle({ pose: poseOfViewpoint(vps[0]), catalog: c.catalog });
  assert.ok(r.droppedCount > 0);
  assert.ok(r.totalBytes <= LIMIT);
  assert.ok(r.frameBytes <= LIMIT);
  // 예산을 명시해도 같은 결과(기본값이 15,000,000 임을 확인)
  const r2 = buildInitialBundle({ pose: poseOfViewpoint(vps[0]), catalog: c.catalog, budgetBytes: LIMIT });
  assert.equal(r.totalBytes, r2.totalBytes);
  assert.equal(r.frameBytes, r2.frameBytes);
  assert.equal(r.droppedCount, r2.droppedCount);
});

test.after(() => {
  console.log('scene            points   .skla bytes  level0 bytes  max totalBytes  dropped(sum of 8 views)');
  for (const r of rows) {
    console.log(`${r.scene.padEnd(14)} ${String(r.points).padStart(8)} ${String(r.sklaBytes).padStart(13)} ${String(r.level0Bytes).padStart(13)} ${String(r.maxTotal).padStart(15)} ${String(r.droppedSum).padStart(10)}`);
  }
});
