import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from './index.mjs';
import * as stubs from './stubs.mjs';

test('높이 규칙: 층×3 m, 없으면 6 m', () => {
  assert.equal(c.buildingHeightM(5), 15);
  assert.equal(c.buildingHeightM(null), 6);
  assert.equal(c.buildingHeightM(0), 6);
  assert.equal(c.buildingHeightM(undefined), 6);
  assert.equal(c.buildingHeightM(NaN), 6);
});

test('타일 번호·범위 왕복', () => {
  assert.deepEqual(c.tileOf(-0.5, 64), { tx: -1, ty: 1 });
  assert.deepEqual(c.tileBounds(-1, 1), { minX: -64, minY: 64, maxX: 0, maxY: 128 });
});

test('상수', () => {
  assert.equal(c.TERRAIN_LOD_MAX_ERROR_M.length, c.TERRAIN_LOD_COUNT);
  assert.deepEqual([...c.DISPLAY_MODES], ['points', 'black', 'aerial']);
  assert.equal(c.DEFAULT_DISPLAY_MODE, 'black');
});

test('부호 있는 넓이: 반시계 양수', () => {
  assert.equal(c.signedArea([[0, 0], [2, 0], [2, 3], [0, 3]]), 6);
  assert.equal(c.signedArea([[0, 0], [0, 3], [2, 3], [2, 0]]), -6);
});

test('스텁은 미구현 오류를 던진다', () => {
  assert.throws(() => stubs.extrudeBuilding({}), c.TowerAssetError);
});
