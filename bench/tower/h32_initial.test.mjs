import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  measureH32Initial, compareBudget, crossCheckEncoder, measureAllH32,
  BUILDINGS_BYTES, DRAPE_MIP2_BYTES, WELCOME_BYTES, INITIAL_TERRAIN_LOD,
} from './h32_initial.mjs';
import { noiseBigDem, smoothDem } from './lod_bytes.mjs';
import { TERRAIN_INITIAL_BUDGET_BYTES, INITIAL_TOTAL_LIMIT_BYTES, terrainH32Bytes } from '../../contracts/tower_assets/terrain_h32.mjs';
import { WELCOME_FRAME_BYTES, PIECE_FRAME_OVERHEAD_BYTES } from '../../server/scheduler/initial/index.mjs';
import { INITIAL_TERRAIN_LOD as ASSETS_TERRAIN_LOD } from '../tower_assets/index.mjs';

// 기준값(손 계산): LOD3 cells 65, 타일 256장, 조각 프레임 머리 38 B.
//   f32   : 256 × (16 + 4·65²) = 256 × 16,916 = 4,330,496 B, wire = + 256·38 = 4,340,224 B
//   양자화: 256 × (24 + 2·65²) = 256 × 8,474 = 2,169,344 B, wire = 2,179,072 B
//   합계(양자화) = 3,157,410 + 1,062,400 + 27 + 2,179,072 = 6,398,909 B, 합계(f32) = 8,560,061 B
const NOISE_LOD3 = Object.freeze({
  cells: 65, tiles: 256,
  f32: { payload: 4_330_496, wire: 4_340_224 },
  quant: { payload: 2_169_344, wire: 2_179_072, quantizedTiles: 256, fallbackTiles: 0 },
});

test('고정 수치가 결정 0056 의 몫 정의·서버 상수와 같다', () => {
  assert.equal(TERRAIN_INITIAL_BUDGET_BYTES, 10_780_163);
  assert.equal(INITIAL_TOTAL_LIMIT_BYTES, 15_000_000);
  assert.equal(WELCOME_BYTES, WELCOME_FRAME_BYTES);
  assert.equal(PIECE_FRAME_OVERHEAD_BYTES, 38);
  assert.equal(INITIAL_TERRAIN_LOD, ASSETS_TERRAIN_LOD);
  assert.equal(INITIAL_TOTAL_LIMIT_BYTES - BUILDINGS_BYTES - DRAPE_MIP2_BYTES - WELCOME_BYTES, TERRAIN_INITIAL_BUDGET_BYTES);
});

test('noiseBig 시드 0 LOD3 256 타일 H32 바이트가 손 계산 기준값과 같다', () => {
  const m = measureH32Initial(noiseBigDem(0));
  assert.equal(m.lod, 3);
  assert.deepEqual({ cells: m.cells, tiles: m.tiles, f32: m.f32, quant: m.quant }, NOISE_LOD3);
});

test('noiseBig 시드 1~3 도 같은 바이트이고 폴백 타일이 없다', () => {
  for (const seed of [1, 2, 3]) {
    const m = measureH32Initial(noiseBigDem(seed));
    assert.deepEqual({ cells: m.cells, tiles: m.tiles, f32: m.f32, quant: m.quant }, NOISE_LOD3, `시드 ${seed}`);
  }
});

test('noiseBig LOD3 양자화 H32 는 지형 몫 이하이고 초기 합계 ≤ 15,000,000 B', () => {
  const m = measureH32Initial(noiseBigDem(0));
  const b = compareBudget(m.quant.wire);
  assert.equal(b.terrainWire, 2_179_072);
  assert.ok(b.terrainWire <= TERRAIN_INITIAL_BUDGET_BYTES);
  assert.equal(b.shareMargin, 8_601_091);
  assert.equal(b.total, 6_398_909);
  assert.ok(b.total <= INITIAL_TOTAL_LIMIT_BYTES);
  assert.equal(b.totalMargin, 8_601_091);
  assert.equal(b.sharePass && b.totalPass, true);
});

test('noiseBig LOD3 비양자화 f32 H32 도 몫 이하이고 합계 여유가 남는다', () => {
  const m = measureH32Initial(noiseBigDem(0));
  const b = compareBudget(m.f32.wire);
  assert.equal(b.terrainWire, 4_340_224);
  assert.ok(b.terrainWire <= TERRAIN_INITIAL_BUDGET_BYTES);
  assert.equal(b.shareMargin, 6_439_939);
  assert.equal(b.total, 8_560_061);
  assert.ok(b.total <= INITIAL_TOTAL_LIMIT_BYTES);
  assert.equal(b.totalMargin, 6_439_939);
  assert.ok(b.totalMargin > 0);
});

test('완만 DEM LOD3 기준값(cells 9)', () => {
  const m = measureH32Initial(smoothDem());
  // 256 × (16 + 4·81) = 87,040 B, 양자화 256 × (24 + 2·81) = 47,616 B
  assert.equal(m.cells, 9);
  assert.equal(m.f32.payload, 87_040);
  assert.equal(m.quant.payload, 47_616);
  assert.equal(m.quant.fallbackTiles, 0);
});

test('LOD0 은 계약대로 양자화하지 않는다(전부 f32 로 센다)', () => {
  const m = measureH32Initial(noiseBigDem(0), { lod: 0, tilesPerSide: 2 });
  assert.equal(m.quant.quantizedTiles, 0);
  assert.equal(m.quant.fallbackTiles, 4);
  assert.equal(m.quant.payload, m.f32.payload);
});

test('범위를 넘는 타일은 f32 폴백으로 센다', () => {
  const dem = noiseBigDem(0);
  // 타일 (0,0) 한 점을 +4000 m 로 올리면 범위/0.05 > 65535 → 그 타일만 폴백
  const h = new Float32Array(dem.heights);
  h[520 * dem.width + 520] = 4000; // 타일 경계(0 m)를 피한 (8 m, 8 m)
  const m = measureH32Initial({ ...dem, heights: h }, { tilesPerSide: 2 });
  assert.equal(m.quant.fallbackTiles, 1);
  assert.equal(m.quant.quantizedTiles, 3);
  assert.equal(m.quant.payload, 3 * 8_474 + 16_916);
});

test('서버 인코더 대조: 인코더가 반드시 있어야 하고, 양자화 256 타일·payload 가 계약 바이트 식에서 유도한 값과 같다', async () => {
  assert.ok(existsSync(new URL('../../server/terrain/height_format/index.mjs', import.meta.url)), '인코더 파일이 없으면 통과하지 않는다');
  const r = await crossCheckEncoder(noiseBigDem(0));
  assert.equal(r.available, true);
  // 기대값은 인코더 출력이 아닌 계약 terrainH32Bytes 에서 직접 유도한다(noiseBig LOD3: 전 타일 양자화, 폴백 0).
  const derived = 256 * terrainH32Bytes(NOISE_LOD3.cells, true);
  assert.equal(r.quantizedTiles, 256);
  assert.equal(r.fallbackTiles, 0);
  assert.equal(r.payload, derived);
  assert.equal(r.expectedPayload, derived);
  assert.equal(r.mismatchTiles, 0);
  assert.equal(r.payload, NOISE_LOD3.quant.payload);
  assert.ok(r.payload + 256 * PIECE_FRAME_OVERHEAD_BYTES <= TERRAIN_INITIAL_BUDGET_BYTES);
});

test('서버 인코더 대조: 완만 DEM 도 전 타일 양자화이고 payload 가 계약 식 유도값과 같다', async () => {
  const r = await crossCheckEncoder(smoothDem());
  assert.equal(r.available, true);
  assert.equal(r.quantizedTiles, 256);
  assert.equal(r.payload, 256 * terrainH32Bytes(9, true));
  assert.equal(r.mismatchTiles, 0);
});

test('measureAllH32 는 모든 DEM 에서 몫·합계를 통과하고 인코더 대조(available true)를 싣는다', async () => {
  const r = await measureAllH32();
  assert.deepEqual(Object.keys(r.rows), ['noiseBig:0', 'noiseBig:1', 'noiseBig:2', 'noiseBig:3', 'smooth']);
  for (const [name, x] of Object.entries(r.rows)) {
    assert.equal(x.budgetQuant.sharePass && x.budgetQuant.totalPass, true, name);
    assert.equal(x.budgetF32.sharePass && x.budgetF32.totalPass, true, name);
    assert.equal(x.encoder.available, true, name);
    assert.equal(x.encoder.quantizedTiles, 256, name);
    assert.equal(x.encoder.mismatchTiles, 0, name);
  }
});

test('② compareBudget 몫 경계: 몫 이하 통과, 몫+1 은 sharePass 거짓(합계는 아직 통과)', () => {
  const at = compareBudget(TERRAIN_INITIAL_BUDGET_BYTES);
  assert.equal(at.sharePass, true);
  assert.equal(at.shareMargin, 0);
  assert.equal(at.total, INITIAL_TOTAL_LIMIT_BYTES);
  assert.equal(at.totalPass, true);
  assert.equal(at.totalMargin, 0);
  const over = compareBudget(TERRAIN_INITIAL_BUDGET_BYTES + 1);
  assert.equal(over.sharePass, false);
  assert.equal(over.shareMargin, -1);
  assert.equal(over.total, INITIAL_TOTAL_LIMIT_BYTES + 1);
  assert.equal(over.totalPass, false);
  assert.equal(over.totalMargin, -1);
  const under = compareBudget(TERRAIN_INITIAL_BUDGET_BYTES - 1);
  assert.equal(under.sharePass, true);
  assert.equal(under.totalPass, true);
  assert.equal(under.total, INITIAL_TOTAL_LIMIT_BYTES - 1);
  assert.equal(under.totalMargin, 1);
});

test('② 합계 15,000,000±1 경계와 몫만 넘는 경우를 판정이 구분한다', () => {
  const fixed = BUILDINGS_BYTES + DRAPE_MIP2_BYTES + WELCOME_BYTES;
  for (const [wire, pass] of [[INITIAL_TOTAL_LIMIT_BYTES - fixed - 1, true], [INITIAL_TOTAL_LIMIT_BYTES - fixed, true], [INITIAL_TOTAL_LIMIT_BYTES - fixed + 1, false]]) {
    const b = compareBudget(wire);
    assert.equal(b.total, INITIAL_TOTAL_LIMIT_BYTES - (INITIAL_TOTAL_LIMIT_BYTES - fixed - wire));
    assert.equal(b.totalPass, pass, `wire ${wire}`);
    assert.equal(b.sharePass, wire <= TERRAIN_INITIAL_BUDGET_BYTES);
  }
  const huge = compareBudget(20_000_000);
  assert.equal(huge.sharePass, false);
  assert.equal(huge.totalPass, false);
  assert.ok(huge.shareMargin < 0 && huge.totalMargin < 0);
});
