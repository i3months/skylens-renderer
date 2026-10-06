// b1_lod.mjs 사본 lodStrides 가 서버 terrainLodStride 와 같은 간격을 내는지 검사한다(F-487 ⑦).
// 결측 타일(유한하지 않은 높이가 섞인 타일)은 서버가 간격 판정에서 빼므로 사본도 같아야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lodStrides } from './b1_lod.mjs';
import { terrainLodStride, terrainMissingTiles } from '../../../server/terrain/mesh_lod/index.mjs';
import { terrainLodMaxErrorM, TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

// 2×1 타일, 셀 2 m(n0 = 32). 왼쪽 타일은 평면, 오른쪽 타일은 ±3 m 지그재그에 NaN 한 점이 섞인 결측 타일.
function missingTileDem() {
  const n0 = 32, width = 2 * n0 + 1, height = n0 + 1;
  const heights = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = n0 + 1; i < width; i++) heights[j * width + i] = ((i + j) % 2 ? 3 : -3);
  }
  heights[5 * width + n0 + 5] = NaN;
  return { originX: 0, originY: 0, cellM: 2, width, height, heights };
}

test('결측 타일이 있는 DEM 에서 사본 간격 == 서버 terrainLodStride', () => {
  const dem = missingTileDem();
  assert.deepEqual(terrainMissingTiles(dem), [{ tx: 1, ty: 0 }], '시험 전제: 오른쪽 타일만 결측');
  // 사본의 상한표는 서버가 쓰는 terrainLodMaxErrorM(lod, cellM) 값으로 준다(기울기 항 포함).
  const bounds = [0, 1, 2, 3].map((lod) => terrainLodMaxErrorM(lod, dem.cellM));
  const { strides } = lodStrides(dem, bounds);
  const server = [0, 1, 2, 3].map((lod) => terrainLodStride(dem, lod));
  assert.deepEqual(strides, server);
  // 평면 타일만 판정에 쓰이므로 명목 간격이 그대로 나온다(결측 타일의 지그재그가 간격을 줄이지 않는다).
  assert.deepEqual(strides, [1, 2, 4, 8]);
});

test('F-496 ⑦: 판정 가능한 타일이 0 이면 사본도 서버처럼 TowerAssetError 를 던진다', () => {
  const bounds = [0, 0.5, 1, 1];
  // (a) 타일 하나도 못 덮는 DEM(한 타일은 33×33 표본이 필요한데 32×32).
  const small = { originX: 0, originY: 0, cellM: 2, width: 32, height: 32, heights: new Float32Array(32 * 32) };
  assert.throws(() => terrainLodStride(small, 1), TowerAssetError, '시험 전제: 서버도 던진다');
  assert.throws(() => lodStrides(small, bounds), TowerAssetError);
  // (b) 덮는 타일이 전부 결측.
  const dem = missingTileDem();
  dem.heights[5 * dem.width + 5] = NaN; // 왼쪽 타일도 결측
  assert.throws(() => terrainLodStride(dem, 1), TowerAssetError, '시험 전제: 서버도 던진다');
  assert.throws(() => lodStrides(dem, bounds), TowerAssetError);
});
