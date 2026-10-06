import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demTileCount, measureDem, lowNoiseDem } from './b1_measure.mjs';
import { makeHillDem } from '../../../client/tower/terrain/fixtures.mjs';

// 6×6 타일 DEM(셀 16 m → 타일당 4 셀). 원점만 바꿔 쓴다.
function gridDem(originX, originY, cellM = 16, tiles = 6) {
  const n = tiles * (64 / cellM) + 1;
  return { originX, originY, cellM, width: n, height: n, heights: new Float32Array(n * n) };
}

test('정렬된 DEM 의 tileCount', () => {
  assert.equal(demTileCount(gridDem(-192, -192)), 36);
  assert.equal(demTileCount(gridDem(0, 64, 64, 4)), 16);
});

test('원점이 +32 m 어긋난 DEM 은 throw', () => {
  assert.throws(() => demTileCount(gridDem(-192 + 32, -192)), /originX/);
  assert.throws(() => demTileCount(gridDem(-192, -192 + 32)), /originY/);
});

test('격자 크기 불일치와 heights 길이 불일치는 throw', () => {
  const d = gridDem(0, 0);
  assert.throws(() => demTileCount({ ...d, width: d.width + 1, heights: new Float32Array((d.width + 1) * d.height) }), /타일 격자/);
  assert.throws(() => demTileCount({ ...d, heights: new Float32Array(10) }), /heights\.length/);
});

test('cellM 0·-1·NaN·3 은 빠르게 명확한 Error', () => {
  const t0 = Date.now();
  for (const c of [0, -1, NaN, 3, Infinity]) {
    assert.throws(() => lowNoiseDem(1, c), /cellM|64\/cellM/);
    assert.throws(() => measureDem({ name: 'x', make: () => ({ ...gridDem(0, 0), cellM: c }) }, [], { check: false }), /cellM|64\/cellM/);
  }
  assert.ok(Date.now() - t0 < 1000);
});

test('기존 DEM tileCount 불변(계산만)', () => {
  assert.equal(demTileCount(gridDem(-512, -512, 1, 16)), 256); // lowNoise 1 m
  assert.equal(demTileCount(gridDem(-512, -512, 2, 16)), 256); // lowNoise2m
  assert.equal(demTileCount(gridDem(-256, -256, 2, 4)), 16); // hill 16
  // 합성 격자가 아니라 실제 생성기 출력에도 같은 값을 단언한다.
  assert.equal(demTileCount(lowNoiseDem(1, 1)), 256);
  assert.equal(demTileCount(lowNoiseDem(1, 2)), 256);
  assert.equal(demTileCount(makeHillDem({ seed: 1, noiseRatio: 0 })), 16);
});
