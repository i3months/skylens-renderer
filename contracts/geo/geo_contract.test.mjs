// contracts/geo 시험: 이름 유지, 지구 반경 상수, enuToScene·sceneToEnu 의 배열 전용·−0 정규화(F-072).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EARTH_RADIUS_M, GeoError, WGS84, enuToScene, sceneToEnu } from './index.mjs';

const isRange = (e) => e instanceof GeoError && e.code === 'range';
const noNegZero = (arr) => arr.every((v) => !Object.is(v, -0));

test('EARTH_RADIUS_M·GeoError 이름과 값', () => {
  // skylens develop src/shared/geo.ts 의 R
  assert.equal(EARTH_RADIUS_M, 6378137);
  assert.equal(WGS84.a, EARTH_RADIUS_M);
  const e = new GeoError('range', 'x');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'GeoError');
  assert.equal(e.code, 'range');
});

test('enuToScene·sceneToEnu: 축 [e,u,−n]·[x,−z,y] 와 왕복', () => {
  assert.deepStrictEqual(enuToScene([1, 2, 3]), [1, 3, -2]);
  assert.deepStrictEqual(sceneToEnu([1, 3, -2]), [1, 2, 3]);
  for (const p of [[0.5, -7.25, 120], [-1e4, 1e4, -200]]) {
    assert.deepStrictEqual(sceneToEnu(enuToScene(p)), p);
  }
});

test('enuToScene·sceneToEnu: −0 은 +0 으로 정규화', () => {
  for (const p of [[0, 0, 0], [-0, -0, -0], [1, -0, 2], [-0, 0, -0]]) {
    assert.ok(noNegZero(enuToScene(p)), `enuToScene ${p}`);
    assert.ok(noNegZero(sceneToEnu(p)), `sceneToEnu ${p}`);
  }
  // n=0 이면 z 는 +0
  assert.deepStrictEqual(enuToScene([1, 0, 2]), [1, 2, 0]);
  assert.deepStrictEqual(enuToScene([-0, -0, -0]), [0, 0, 0]);
  assert.deepStrictEqual(sceneToEnu([-0, -0, 0]), [0, 0, 0]);
});

test('enuToScene·sceneToEnu: 배열이 아니거나 형태가 틀리면 GeoError(range)', () => {
  for (const fn of [enuToScene, sceneToEnu]) {
    for (const bad of [
      { e: 1, n: 2, u: 3 }, { x: 1, y: 2, z: 3 }, { 0: 1, 1: 2, 2: 3, length: 3 }, new Float64Array(3),
      null, undefined, 1, 'abc', [1, 2], [1, 2, 3, 4], [1, NaN, 3], [Infinity, 0, 0], [0, 0, '1'],
    ]) {
      assert.throws(() => fn(bad), isRange);
    }
  }
});
