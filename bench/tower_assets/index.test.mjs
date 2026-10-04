import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { measureTowerAssets, INITIAL_TERRAIN_LOD, INITIAL_DRAPE_MIP } from './index.mjs';
import { runOffline } from '../../server/terrain/offline/index.mjs';
import { INITIAL_BUDGET_BYTES } from '../../server/scheduler/initial/index.mjs';

// 초기 상한: 리터럴 상수(계약 값과 같음을 아래에서 단언).
const LIMIT_BYTES = 15_000_000;

// 측정은 한 번만 하고, 네트워크 호출 0 을 함께 확인한다.
const measured = await runOffline(() => measureTowerAssets());
const result = measured.result;

test('측정 중 네트워크 호출 0', () => {
  assert.equal(measured.networkCalls, 0);
});

test('상한 리터럴이 초기 묶음 상수와 같다', () => {
  assert.equal(LIMIT_BYTES, INITIAL_BUDGET_BYTES);
  assert.equal(result.limitBytes, LIMIT_BYTES);
});

test('건물 수', () => {
  assert.equal(result.buildings.count, 6191);
});

test('크기 내역 합 = totalSize, 드레이프 항목 존재', () => {
  const b = result.breakdown;
  assert.ok(b.drape > 0, '드레이프 항목');
  assert.ok(b.buildings > 0 && b.terrain > 0);
  assert.equal(result.totalSize, b.buildings + b.terrain + b.drape);
  const m = result.breakdownMip0;
  assert.equal(result.totalSizeMip0, m.buildings + m.terrain + m.drape);
  assert.equal(result.initial.terrainLod, INITIAL_TERRAIN_LOD);
  assert.equal(result.initial.drapeMip, INITIAL_DRAPE_MIP);
});

test('드레이프 크기: 256 타일, 밉0 = 256 × (38 + 16 + 49152), 밉2 = 256 × (38 + 16 + 3072)', () => {
  assert.equal(result.drape.tileCount, 256);
  assert.equal(result.drape.size[0], 256 * (38 + 16 + 128 * 128 * 3));
  assert.equal(result.drape.size[2], 256 * (38 + 16 + 32 * 32 * 3));
  assert.ok(result.drape.size[0] > result.drape.size[1] && result.drape.size[1] > result.drape.size[2]);
});

test('초과 기록 필드가 실제 크기와 일치한다(상한 변경 없이 넘으면 넘는 대로 기록)', () => {
  assert.equal(result.exceeds, result.totalSize > LIMIT_BYTES);
  assert.equal(result.overBytes, Math.max(0, result.totalSize - LIMIT_BYTES));
  assert.equal(result.exceedsMip0, result.totalSizeMip0 > LIMIT_BYTES);
  assert.equal(result.overBytesMip0, Math.max(0, result.totalSizeMip0 - LIMIT_BYTES));
  assert.ok(result.totalSizeMip0 > result.totalSize);
});

test('매끈한 DEM: LOD 별 크기가 서로 다르다(LOD 가 일을 한다)', () => {
  const s = result.smoothTerrain.size;
  assert.ok(s[0] > s[1] && s[1] > s[2] && s[2] > s[3], JSON.stringify(s));
  assert.equal(result.smoothTerrain.tileCount, 256);
});

test('잡음 DEM 은 LOD 가 줄일 수 없어 크기가 같다(대조)', () => {
  const n = result.terrain.size;
  assert.equal(n[0], n[3]);
});

test('벤치 시험 뒤 원본 복원', () => {
  assert.equal(typeof globalThis.fetch, 'function');
  assert.ok(!String(globalThis.fetch).includes('blocked'));
});

test('타이밍 기록', () => {
  for (const k of ['extrude', 'lod500m', 'lod5km']) assert.ok(result.buildings.timings[k] >= 0);
  console.log(JSON.stringify({ breakdown: result.breakdown, totalSize: result.totalSize, breakdownMip0: result.breakdownMip0, totalSizeMip0: result.totalSizeMip0, exceeds: result.exceeds, overBytes: result.overBytes, exceedsMip0: result.exceedsMip0, overBytesMip0: result.overBytesMip0, noisy: result.terrain.size, smooth: result.smoothTerrain.size, smoothCells: result.smoothTerrain.cells, drape: result.drape.size, bRaw: result.buildings.size }));
});
