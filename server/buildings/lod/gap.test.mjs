// Gap-cell rules of the building LOD (F-334 trapped gap width, F-335 long gap cells).
// Expected values are literal numbers worked out by hand from the geometry below, not read back from the implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingLod, BUILDING_LOD_REF_PIXEL_RAD, BUILDING_LOD_MAX_GAP_PX } from './index.mjs';
import { prism } from './scene.mjs';

// One floor = 3 m, so every building below has the same height and no height step.
const rect = (id, x0, y0, x1, y1) => ({ id, mesh: prism([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 1) });
// Number of boxes in the output (a box is 10 triangles; originals would not be a multiple of 10 here: a prism is 10 too,
// so the tests also check that every id ended in one group).
const boxCount = (out) => out.reduce((n, g) => n + g.mesh.indices.length / 3 / 10, 0);

test('hideTol at 5 km and 500 m (literal values used below)', () => {
  // 5000 × (π/3/1080) × 0.25 = 1.2120 m, 500 m → 0.1212 m.
  assert.ok(Math.abs(5000 * BUILDING_LOD_REF_PIXEL_RAD * BUILDING_LOD_MAX_GAP_PX - 1.2120) < 1e-4);
  assert.ok(Math.abs(500 * BUILDING_LOD_REF_PIXEL_RAD * BUILDING_LOD_MAX_GAP_PX - 0.12120) < 1e-5);
});

// F-334 layout: a1, a2 are 2 × 2 m with a trapped gap of width w between them; a3, a4 are 0.5 m deep strips behind them
// that stick 0.6 m into the gap from each side (strip gap w − 1.2). Through the strips the pair could be merged although
// a1–a2 alone are not candidates (box gap w > hideTol).
function fourBlocks(w) {
  return [
    rect(1, 8, 0, 10, 2),
    rect(2, 10 + w, 0, 12 + w, 2),
    rect(3, 8, 2, 10.6, 2.5),
    rect(4, 10 + w - 0.6, 2, 12 + w, 2.5),
  ];
}

test('F-334: 4 blocks at 5 km, trapped gap wider than hideTol (1.212 m) is not roofed over', () => {
  for (const w of [2.2, 1.8, 1.5, 1.25]) {
    const out = buildBuildingLod(fourBlocks(w), 5000);
    assert.deepEqual(out.flatMap((g) => g.ids).sort(), [1, 2, 3, 4]);
    assert.ok(boxCount(out) >= 2, `w ${w} m: ${boxCount(out)} box(es), the ${w} m gap was filled`);
  }
});

test('F-334: same layout with a gap narrower than hideTol still merges into one box', () => {
  // w = 1.15 m < 1.212 m: the strips overlap by 0.05 m and the trapped gap is 1.15 m wide.
  const out = buildBuildingLod(fourBlocks(1.15), 5000);
  assert.equal(boxCount(out), 1);
  // The pair alone (no strips) behaves the same way: 1.15 m merges, 1.25 m does not.
  assert.equal(boxCount(buildBuildingLod([rect(1, 8, 0, 10, 2), rect(2, 11.15, 0, 13.15, 2)], 5000)), 1);
  assert.equal(boxCount(buildBuildingLod([rect(1, 8, 0, 10, 2), rect(2, 11.25, 0, 13.25, 2)], 5000)), 2);
});

test('F-335: 5 km, two 10 × L buildings with a 1.2 m gap merge for long L (150, 200, 300 m)', () => {
  for (const L of [150, 200, 300]) {
    const out = buildBuildingLod([rect(1, 0, 0, 10, L), rect(2, 11.2, 0, 21.2, L)], 5000);
    assert.deepEqual(out.map((g) => g.ids), [[1, 2]]);
    assert.equal(boxCount(out), 1, `L ${L} m`);
  }
});

test('F-335: 500 m, two 5 m wide buildings with a 0.03 m gap merge for L ≥ 30 m', () => {
  for (const L of [30, 60, 120]) {
    const out = buildBuildingLod([rect(1, 0, 0, 5, L), rect(2, 5.03, 0, 10.03, L)], 500);
    assert.equal(boxCount(out), 1, `L ${L} m`);
  }
});

test('F-335: the measured gap of a 300 m long gap is its true width (switch between 4900 m and 5000 m for 1.2 m)', () => {
  // A trapped gap of width 1.2 m merges exactly when hideTol ≥ 1.2 m, i.e. distance ≥ 1.2 / 2.424e-4 = 4950.3 m.
  // With the old 129-sample grid the 300 m gap cell had 2.3 m spacing and never merged at 5 km.
  const pair = [rect(1, 0, 0, 10, 300), rect(2, 11.2, 0, 21.2, 300)];
  assert.equal(boxCount(buildBuildingLod(pair, 4900)), 2);
  assert.equal(boxCount(buildBuildingLod(pair, 5000)), 1);
  // 1.25 m > 1.212 m: not merged at 5 km.
  assert.equal(boxCount(buildBuildingLod([rect(1, 0, 0, 10, 300), rect(2, 11.25, 0, 21.25, 300)], 5000)), 2);
});

test('open corner keeps the old limit: staggered pair with an 8 m empty corner switches between hideTol 7.9 m and 8.1 m', () => {
  // A [0,20]², B [20.2,40]×[8,28]: the empty corners of the merged box reach 8 m from the buildings and open to the outside,
  // so the roofed depth is 8 m (not 16 m). hideTol 7.9 m ↔ 32,590 m, 8.1 m ↔ 33,415 m.
  const pair = [rect(1, 0, 0, 20, 20), rect(2, 20.2, 8, 40, 28)];
  assert.equal(boxCount(buildBuildingLod(pair, 32590)), 2);
  assert.equal(boxCount(buildBuildingLod(pair, 33415)), 1);
});

test('long gap check stays fast: 20 pairs of 300 m buildings at 5 km in under 1 s', () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(rect(2 * i + 1, 0, i * 3, 300, i * 3 + 2.4));
  const t0 = performance.now();
  const out = buildBuildingLod(list, 5000);
  const ms = performance.now() - t0;
  // Rows 2.4 m deep with 0.6 m gaps (≤ 1.212 m) merge into one box.
  assert.equal(boxCount(out), 1);
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});

test('F-338: chained merge re-measures the earlier cluster gap, 1.8 m trapped gap at 5 km is not roofed over', () => {
  // a1 [0,2]×[0,2] 와 a3 [0,3.2]×[2,2.5] 가 먼저 합쳐지면 [2,3.2]×[0,2] 는 바깥으로 열린 홈(깊이 1.2 m ≤ 1.212 m)이다.
  // a2 [3.8,5.8]×[0,2] 가 붙으면 그 홈과 새 틈 칸 [3.2,3.8]×[0,2] 가 폭 1.8 m · 깊이 2 m 의 끼인 틈 [2,3.8]×[0,2] 가 된다.
  // 1.8 m > hideTol(1.212 m) 이므로 상자 하나로 메우면 안 된다.
  const out = buildBuildingLod([rect(1, 0, 0, 2, 2), rect(2, 3.8, 0, 5.8, 2), rect(3, 0, 2, 3.2, 2.5)], 5000);
  assert.deepEqual(out.flatMap((g) => g.ids).sort(), [1, 2, 3]);
  assert.ok(boxCount(out) >= 2, `${boxCount(out)} box(es), the 1.8 m gap was filled`);
});
