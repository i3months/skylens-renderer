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
  // 벽시계는 부하에 민감하므로 이 스레드의 CPU 시간으로 잰다. 정상 경로는 검사만 하고 곧바로 던지므로 수 ms 지만,
  // 1024 m DEM 을 실제로 만들어 재 버리면 수백 ms~수 초라 CPU 시간 2000 ms(정상의 100 배 이상 여유)로 구분한다.
  const c0 = process.threadCpuUsage();
  for (const c of [0, -1, NaN, 3, Infinity]) {
    assert.throws(() => lowNoiseDem(1, c), /cellM|64\/cellM/);
    assert.throws(() => measureDem({ name: 'x', make: () => ({ ...gridDem(0, 0), cellM: c }) }, [], { check: false }), /cellM|64\/cellM/);
  }
  const c1 = process.threadCpuUsage(c0);
  assert.ok((c1.user + c1.system) / 1000 < 2000, `CPU 시간 ${(c1.user + c1.system) / 1000} ms`);
});

test('기존 DEM tileCount 불변(계산만)', () => {
  assert.equal(demTileCount(gridDem(-512, -512, 1, 16)), 256); // lowNoise 1 m
  assert.equal(demTileCount(gridDem(-512, -512, 2, 16)), 256); // lowNoise2m
  assert.equal(demTileCount(gridDem(-256, -256, 2, 4)), 16); // hill 16
  // 합성 격자가 아니라 실제 생성기 출력에도 같은 값을 단언한다.
  assert.equal(demTileCount(lowNoiseDem(1, 1)), 256);
  // 타일 수만으로는 원점이 한 타일 이동해도 통과하므로 원점도 못 박는다(F-491 ⑪).
  for (const cellM of [1, 2]) {
    const d = lowNoiseDem(1, cellM);
    assert.equal(d.originX, -512);
    assert.equal(d.originY, -512);
  }
  assert.equal(demTileCount(lowNoiseDem(1, 2)), 256);
  assert.equal(demTileCount(makeHillDem({ seed: 1, noiseRatio: 0 })), 16);
});
