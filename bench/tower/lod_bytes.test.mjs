// T15.10 지형 LOD 바이트 측정 시험.
// 아래 범위·정확값은 사후에 맞춘 값이다: 결정적 합성 DEM(완만 / noiseBig 시드 0)을 먼저 측정(2026-10)한 뒤 그 결과 둘레에 범위를 박았다.
// SPEC 기준에서 나온 수치가 아니라 회귀 감시용이다. 예산(INITIAL_LIMIT_BYTES)은 SPEC S6 초기 ≤ 15 MB 이며 시험이 바꾸지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureLodBytes, smoothDem, noiseBigDem, measureAll, clearLodBytesCache } from './lod_bytes.mjs';
import { INITIAL_LIMIT_BYTES } from '../tower_assets/index.mjs';
import { PIECE_FRAME_OVERHEAD_BYTES } from '../../server/scheduler/initial/index.mjs';

// 시간: measureAll 한 번이 smooth·noiseBig(0) 을 재고, 아래 시험이 그 결과를 재사용한다.
clearLodBytesCache();
const all = measureAll();
const smooth = all.dems.smooth;
const rough = all.dems.noiseBig;
const raw = (r) => r.levels.map((l) => l.rawBytes);

test('예산 상수는 SPEC S6 초기 15 MB 그대로', () => {
  assert.equal(INITIAL_LIMIT_BYTES, 15_000_000);
});

test('완만 DEM: 정점 수 65/33/17/9, 단계마다 약 1/4(사후 측정 범위)', () => {
  assert.deepEqual(smooth.levels.map((l) => l.cells), [65, 33, 17, 9]);
  assert.deepEqual(raw(smooth), [38158848, 9650688, 2474496, 655872]); // 측정 후 고정(정확값)
  for (const l of smooth.levels) assert.equal(l.tiles, 256);
  assert.ok(smooth.ratios.lod3OverLod2.raw > 0.25 && smooth.ratios.lod3OverLod2.raw < 0.28);
  assert.ok(smooth.ratios.lod3OverLod0.raw > 0.016 && smooth.ratios.lod3OverLod0.raw < 0.019);
  assert.ok(smooth.ratios.lod3OverLod2.gzip > 0.27 && smooth.ratios.lod3OverLod2.gzip < 0.30);
  assert.ok(smooth.ratios.lod3OverLod0.gzip > 0.018 && smooth.ratios.lod3OverLod0.gzip < 0.021);
  assert.equal(smooth.lod3NotSmallerThanLod2, false);
  assert.equal(smooth.lod3OverBudgetRaw, false);
  assert.equal(smooth.lod3OverBudgetGzip, false);
});

test('완만 DEM: gzip 은 raw 보다 작고 단계가 거칠수록 줄어든다', () => {
  for (const l of smooth.levels) assert.ok(l.gzipBytes < l.rawBytes);
  for (let k = 1; k < 4; k++) assert.ok(smooth.levels[k].gzipBytes < smooth.levels[k - 1].gzipBytes);
  assert.ok(smooth.levels[0].gzipBytes > 12_500_000 && smooth.levels[0].gzipBytes < 13_500_000);
});

test('거친 DEM(noiseBig): 상한 1 m 로는 LOD1~3 이 모두 원본으로 물러나 LOD3 = LOD2 = LOD0 (0046 다시 볼 조건 해당)', () => {
  assert.deepEqual(rough.levels.map((l) => l.cells), [65, 65, 65, 65]);
  assert.deepEqual(raw(rough), [38158848, 38158848, 38158848, 38158848]);
  assert.equal(rough.ratios.lod3OverLod2.raw, 1);
  assert.equal(rough.ratios.lod3OverLod0.gzip, 1);
  assert.equal(rough.lod3NotSmallerThanLod2, true);
  assert.equal(rough.lod3OverBudgetRaw, true);
  // gzip 은 이 합성 잡음에서 15 MB 아래(잡음 폭이 좁아 압축이 잘 됨). 사후 측정 범위.
  assert.ok(rough.levels[3].gzipBytes > 11_500_000 && rough.levels[3].gzipBytes < 12_700_000);
  assert.equal(rough.lod3OverBudgetGzip, false);
});

test('결정성: 캐시를 우회한 독립 계산 두 번이 같은 바이트, 시드가 달라도 거친 DEM 은 LOD3 = LOD0 크기', () => {
  clearLodBytesCache();
  // 가운데 8 x 8 타일(64 개)만: 시간 절약. 전체 256 타일 값은 위 measureAll 이 한 번 계산했다.
  const a = measureLodBytes(noiseBigDem(0), { tilesPerSide: 8 }); // 캐시가 비어 있어 새로 계산
  clearLodBytesCache();
  const b = measureLodBytes(noiseBigDem(0), { tilesPerSide: 8 }); // 다시 비우고 독립 계산: 같은 객체가 아니어야 한다
  assert.notEqual(a, b);
  assert.notEqual(a.levels, b.levels);
  assert.deepEqual(a, b);
  assert.equal(a.levels[0].tiles, 64);
  assert.equal(a.levels[0].rawBytes, rough.levels[0].rawBytes / 4); // 가운데 64 타일은 거친 DEM 에서 전체의 1/4(타일마다 같은 크기)
  // 시드 비교는 가운데 4 x 4 타일(시간 절약, 전체 256 타일 계산은 위 measureAll 의 한 번)
  const r0 = measureLodBytes(noiseBigDem(0), { tilesPerSide: 4 });
  const r1 = measureLodBytes(noiseBigDem(1), { tilesPerSide: 4 });
  assert.equal(r1.levels[3].rawBytes, r1.levels[0].rawBytes);
  assert.notEqual(r1.levels[0].gzipBytes, r0.levels[0].gzipBytes);
});

test('heightOnlyBytes: 타일 256 개 x (조각 머리 + 메시 머리 16 + 높이 f32 cells^2), noiseBig LOD0~3 모두 4,340,224 B', () => {
  for (const dem of [smooth, rough]) {
    for (const l of dem.levels) {
      assert.equal(l.heightOnlyBytes, 256 * (PIECE_FRAME_OVERHEAD_BYTES + 16 + l.cells * l.cells * 4));
    }
  }
  assert.deepEqual(smooth.levels.map((l) => l.heightOnlyBytes), [4340224, 1128960, 309760, 96768]);
  assert.deepEqual(rough.levels.map((l) => l.heightOnlyBytes), [4340224, 4340224, 4340224, 4340224]);
});

test('measureAll 은 JSON 직렬화 가능하고 상한표 [0, 0.5, 1, 1] 을 싣는다', () => {
  assert.deepEqual(all.maxErrorM, [0, 0.5, 1, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(all.dems.smooth)), smooth);
});

test('③ tilesPerSide 가 0·음수·홀수·NaN·비정수면 RangeError', () => {
  const dem = smoothDem();
  // tilesPerSide = 0
  assert.throws(() => measureLodBytes(dem, { tilesPerSide: 0 }), RangeError);
  // tilesPerSide = -4 (음수)
  assert.throws(() => measureLodBytes(dem, { tilesPerSide: -4 }), RangeError);
  // tilesPerSide = 3 (홀수)
  assert.throws(() => measureLodBytes(dem, { tilesPerSide: 3 }), RangeError);
  // tilesPerSide = NaN
  assert.throws(() => measureLodBytes(dem, { tilesPerSide: NaN }), RangeError);
  // tilesPerSide = 4.5 (비정수)
  assert.throws(() => measureLodBytes(dem, { tilesPerSide: 4.5 }), RangeError);
});

test('⑤ 캐시가 돌려주는 객체는 깊은 동결로 호출자 변경이 캐시를 오염하지 못한다', () => {
  clearLodBytesCache();
  const dem = noiseBigDem(42);
  const result1 = measureLodBytes(dem, { tilesPerSide: 4 });
  // 캐시가 저장한 객체를 변경할 수 없다
  assert.throws(() => {
    result1.levels[0].rawBytes = 999;
  }, TypeError);
  // 캐시에서 다시 받은 객체도 변경할 수 없다
  const result2 = measureLodBytes(dem, { tilesPerSide: 4 });
  assert.throws(() => {
    result2.ratios.lod3OverLod2.raw = 999;
  }, TypeError);
  // 둘 다 캐시 객체(같은 참조)
  assert.equal(result1, result2);
  // 데이터는 같다
  assert.deepEqual(result1, result2);
});
