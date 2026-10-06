// T15.10b-B3 변형 도구 자체 검사(작은 DEM, 빠름). 수치 문턱은 손계산 가능한 구성에서만 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demTiles, makeVariants, buildVariantTiles, crackStats, capStride, tileError, globalStrideCopy } from './b3_lod.mjs';
import { terrainLodStride } from '../../../server/terrain/mesh_lod/index.mjs';

// 2×1 타일, 셀 2 m(n0 = 32). 왼쪽 타일은 평면(0, 공유 변만 아래 지그재그), 오른쪽 타일 안쪽(i > n0)은 ±3 m 지그재그.
function twoTileDem() {
  const n0 = 32, width = 2 * n0 + 1, height = n0 + 1;
  const heights = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = n0 + 1; i < width; i++) heights[j * width + i] = ((i + j) % 2 ? 3 : -3);
  }
  // 공유 변(i = n0): 홀수 j 만 0.5. 굵은 쪽(왼쪽, 간격 8)의 변 정점(짝수 j)은 0 이라 변이 0 인 직선이고, 가는 쪽(오른쪽)은 표본 그대로.
  for (let j = 1; j < height - 1; j += 2) heights[j * width + n0] = 0.5;
  return { originX: 0, originY: 0, cellM: 2, width, height, heights };
}

test('capStride: 정점 상한을 지키는 가장 작은 2 의 거듭제곱 간격', () => {
  assert.equal(capStride(64, 1089), 2); // 33² = 1089
  assert.equal(capStride(64, 1088), 4);
  assert.equal(capStride(64, 81), 8);
  assert.equal(capStride(64, 4225), 1);
  assert.equal(capStride(32, 1089), 1);
});

test('전역 간격 사본 = 서버 terrainLodStride', () => {
  const dem = twoTileDem();
  for (const lod of [0, 1, 2, 3]) assert.equal(globalStrideCopy(dem, lod), terrainLodStride(dem, lod));
});

test('perTile 은 이웃 간격이 달라 공유 변에 틈이 나고, perTileSnap 은 틈을 닫고, baseline·cap 은 틈이 없다', () => {
  const dem = twoTileDem();
  const ctx = demTiles(dem);
  const vs = Object.fromEntries(makeVariants({ budgetCapVertices: 81 }).map((v) => [v.name, v]));
  const lod = 3;
  const pt = buildVariantTiles(dem, ctx, vs.perTile, lod);
  assert.notEqual(pt.tiles[0].cells, pt.tiles[1].cells, '두 타일 간격이 달라야 한다');
  const c1 = crackStats(dem, ctx, pt.tiles);
  assert.equal(c1.edges, 1);
  assert.equal(c1.mismatchedEdges, 1);
  assert.equal(c1.crackEdges, 1);
  // 오른쪽(간격 1)은 공유 변 표본 0.5, 왼쪽(굵음)은 모서리 0 사이 선형 → 틈 0.5 m
  assert.ok(Math.abs(c1.maxGapM - 0.5) < 1e-6, `틈 ${c1.maxGapM}`);
  const sn = buildVariantTiles(dem, ctx, vs.perTileSnap, lod);
  const c2 = crackStats(dem, ctx, sn.tiles);
  assert.equal(c2.mismatchedEdges, 1);
  assert.equal(c2.crackEdges, 0);
  assert.ok(c2.maxGapM < 1e-6);
  for (const name of ['baseline', 'cap81']) {
    const b = buildVariantTiles(dem, ctx, vs[name], lod);
    assert.equal(crackStats(dem, ctx, b.tiles).crackEdges, 0, name);
  }
  // baseline 은 오차 상한(1 m)을 지키고, 정점 상한 81(n0 = 32 에서 간격 4)은 지키지 않을 수 있다.
  const base = buildVariantTiles(dem, ctx, vs.baseline, lod);
  for (const t of base.tiles) assert.ok(tileError(dem, ctx, t) <= 1);
  const cap = buildVariantTiles(dem, ctx, vs.cap81, lod);
  assert.ok(cap.tiles.every((t) => t.cells === 9));
  assert.ok(Math.max(...cap.tiles.map((t) => tileError(dem, ctx, t))) > 1);
});
