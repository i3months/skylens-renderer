import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  measureH32Initial, compareBudget, crossCheckEncoder, measureAllH32,
  BUILDINGS_BYTES, DRAPE_MIP2_BYTES, WELCOME_BYTES, INITIAL_TERRAIN_LOD,
} from './h32_initial.mjs';
import { noiseBigDem, smoothDem } from './lod_bytes.mjs';
import { TERRAIN_INITIAL_BUDGET_BYTES, INITIAL_TOTAL_LIMIT_BYTES } from '../../contracts/tower_assets/terrain_h32.mjs';
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

test('서버 인코더 대조: 있으면 실제 길이 합이 계약 계산과 같고, 없으면 대조 불가로 표시한다', async (t) => {
  const present = existsSync(new URL('../../server/terrain/height_format/index.mjs', import.meta.url));
  const r = await crossCheckEncoder(noiseBigDem(0));
  if (!present) {
    assert.deepEqual(r, { available: false });
    t.diagnostic('대조 가능 여부: 불가(server/terrain/height_format/index.mjs 없음)');
    return;
  }
  assert.equal(r.available, true);
  t.diagnostic(`대조 가능 여부: 가능, 실제 payload ${r.payload} B`);
  assert.equal(r.mismatchTiles, 0);
  assert.equal(r.payload, r.expectedPayload);
  assert.equal(r.quantizedTiles + r.fallbackTiles, 256);
  assert.ok([NOISE_LOD3.f32.payload, NOISE_LOD3.quant.payload].includes(r.payload) || r.fallbackTiles > 0);
  assert.ok(r.payload + 256 * PIECE_FRAME_OVERHEAD_BYTES <= TERRAIN_INITIAL_BUDGET_BYTES);
});

test('measureAllH32 는 모든 DEM 에서 몫·합계를 통과하고 대조 가능 여부를 싣는다', async () => {
  const r = await measureAllH32();
  assert.deepEqual(Object.keys(r.rows), ['noiseBig:0', 'noiseBig:1', 'noiseBig:2', 'noiseBig:3', 'smooth']);
  for (const [name, x] of Object.entries(r.rows)) {
    assert.equal(x.budgetQuant.sharePass && x.budgetQuant.totalPass, true, name);
    assert.equal(x.budgetF32.sharePass && x.budgetF32.totalPass, true, name);
    assert.equal(typeof x.encoder.available, 'boolean', name);
  }
});
