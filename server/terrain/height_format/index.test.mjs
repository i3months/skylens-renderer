import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTerrainTileH32 } from './index.mjs';
import {
  terrainH32Bytes, dequantizeHeights, TERRAIN_H32_STEP_M,
} from '../../../contracts/tower_assets/terrain_h32.mjs';
import { TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

// 시드 고정 PRNG(mulberry32)
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeHeights(cells, seed, lo = 20, span = 30) {
  const r = prng(seed);
  const h = new Float32Array(cells * cells);
  for (let k = 0; k < h.length; k++) h[k] = lo + r() * span;
  return h;
}
const hex = (b) => Buffer.from(b).toString('hex');

test('바이트 길이 = terrainH32Bytes (양자화 8·비양자화 8 모두, 숫자 박기)', () => {
  const h = makeHeights(65, 1);
  const q = encodeTerrainTileH32({ tx: 1, ty: 2, lod: 2, cells: 65, heights: h });
  const f = encodeTerrainTileH32({ tx: 1, ty: 2, lod: 2, cells: 65, heights: h }, { quantize: false });
  assert.equal(q.length, terrainH32Bytes(65, true));
  assert.equal(f.length, terrainH32Bytes(65, false));
  assert.equal(q.length, 16 + 8 + 2 * 65 * 65); // 8474
  assert.equal(q.length, 8474);
  assert.equal(f.length, 16 + 4 * 65 * 65); // 16916
  assert.equal(f.length, 16916);
});

test('머리 필드 바이트 위치 (양자화)', () => {
  const h = new Float32Array([10, 11, 12, 13]);
  const b = encodeTerrainTileH32({ tx: -3, ty: 70000, lod: 3, cells: 2, heights: h });
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(b[0], 0x48);
  assert.equal(b[1], 1);
  assert.equal(b[2], 3);
  assert.equal(b[3], 1);
  assert.equal(dv.getInt32(4, true), -3);
  assert.equal(dv.getInt32(8, true), 70000);
  assert.equal(dv.getUint16(12, true), 2);
  assert.equal(dv.getUint16(14, true), 0);
  assert.equal(dv.getFloat32(16, true), 10);
  assert.equal(dv.getFloat32(20, true), Math.fround(0.05));
  assert.deepEqual([...b.subarray(4, 8)], [0xfd, 0xff, 0xff, 0xff]);
  assert.deepEqual([...b.subarray(8, 12)], [0x70, 0x11, 0x01, 0x00]); // 70000 = 0x11170
  assert.equal(b.length, 16 + 8 + 8);
  assert.equal(dv.getUint16(24, true), 0);
  assert.equal(dv.getUint16(26, true), 20); // (11-10)/0.05
  assert.equal(dv.getUint16(28, true), 40);
  assert.equal(dv.getUint16(30, true), 60);
});

test('머리 필드 바이트 위치 (비양자화 · i32 경계)', () => {
  const h = new Float32Array([1.5, -2.25, 0, 100]);
  const b = encodeTerrainTileH32({ tx: 2147483647, ty: -2147483648, lod: 1, cells: 2, heights: h }, { quantize: false });
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(b[3], 0);
  assert.equal(dv.getInt32(4, true), 2147483647);
  assert.equal(dv.getInt32(8, true), -2147483648);
  assert.equal(b.length, 32);
  assert.equal(dv.getFloat32(16, true), 1.5);
  assert.equal(dv.getFloat32(20, true), -2.25);
  assert.equal(dv.getFloat32(24, true), 0);
  assert.equal(dv.getFloat32(28, true), 100);
});

test('같은 입력은 두 번 인코딩해도 같은 바이트', () => {
  const t = { tx: 4, ty: -9, lod: 2, cells: 17, heights: makeHeights(17, 7) };
  assert.deepEqual(encodeTerrainTileH32(t), encodeTerrainTileH32({ ...t, heights: new Float32Array(t.heights) }));
  const t0 = { ...t, lod: 0 };
  assert.deepEqual(encodeTerrainTileH32(t0), encodeTerrainTileH32(t0));
});

test('기본값: lod≥1 양자화, LOD0 은 늘 비양자화(quantize:true 여도)', () => {
  const h = makeHeights(5, 3);
  for (const lod of [1, 2, 3]) assert.equal(encodeTerrainTileH32({ tx: 0, ty: 0, lod, cells: 5, heights: h })[3], 1);
  const a = encodeTerrainTileH32({ tx: 0, ty: 0, lod: 0, cells: 5, heights: h });
  const b = encodeTerrainTileH32({ tx: 0, ty: 0, lod: 0, cells: 5, heights: h }, { quantize: true });
  assert.equal(a[3], 0);
  assert.equal(b[3], 0);
  assert.equal(a.length, 16 + 4 * 25);
  assert.deepEqual(a, b);
  const dv = new DataView(a.buffer);
  for (let k = 0; k < 25; k++) assert.equal(dv.getFloat32(16 + 4 * k, true), h[k]); // 무손실
});

test('범위 초과 타일은 f32 로 폴백한다', () => {
  // (max-min)/0.05 > 65535 ⇒ 범위 > 3276.75 m
  const over = new Float32Array([0, 3276.8, 1, 2]);
  const b = encodeTerrainTileH32({ tx: 0, ty: 0, lod: 2, cells: 2, heights: over });
  assert.equal(b[3], 0);
  assert.equal(b.length, 32);
  assert.equal(new DataView(b.buffer).getFloat32(20, true), Math.fround(3276.8));
  const edge = new Float32Array([0, 3276, 1, 2]); // 65520 단계, 범위 안
  assert.equal(encodeTerrainTileH32({ tx: 0, ty: 0, lod: 2, cells: 2, heights: edge })[3], 1);
});

test('양자화 복원 오차 ≤ step/2 + f32 반올림', () => {
  const cells = 33;
  const h = makeHeights(cells, 11, -5, 120);
  const b = encodeTerrainTileH32({ tx: 0, ty: 0, lod: 1, cells, heights: h });
  const dv = new DataView(b.buffer);
  const base = dv.getFloat32(16, true), step = dv.getFloat32(20, true);
  const q = new Uint16Array(cells * cells);
  for (let k = 0; k < q.length; k++) q[k] = dv.getUint16(24 + 2 * k, true);
  const back = dequantizeHeights(base, step, q);
  const tol = TERRAIN_H32_STEP_M / 2 + 1e-5; // f32 반올림(|h|≤125 에서 ≈ 8e-6)
  let worst = 0;
  for (let k = 0; k < q.length; k++) worst = Math.max(worst, Math.abs(back[k] - h[k]));
  assert.ok(worst <= tol, `worst ${worst}`);
  assert.ok(worst > 0.001, '양자화가 실제로 일어났다');
  assert.equal(base, Math.fround(Math.min(...h)));
});

test('음성 입력 거부 (12종)', () => {
  const ok = { tx: 0, ty: 0, lod: 1, cells: 3, heights: new Float32Array(9) };
  const bad = [
    ['null', null],
    ['lod -1', { ...ok, lod: -1 }],
    ['lod 4', { ...ok, lod: 4 }],
    ['lod 1.5', { ...ok, lod: 1.5 }],
    ['tx 소수', { ...ok, tx: 0.5 }],
    ['ty NaN', { ...ok, ty: NaN }],
    ['tx i32 초과', { ...ok, tx: 2147483648 }],
    ['ty i32 미만', { ...ok, ty: -2147483649 }],
    ['cells 1', { ...ok, cells: 1, heights: new Float32Array(1) }],
    ['cells 65536', { ...ok, cells: 65536, heights: new Float32Array(0) }],
    ['길이 불일치', { ...ok, heights: new Float32Array(8) }],
    ['heights 배열 아님', { ...ok, heights: [0, 0, 0, 0, 0, 0, 0, 0, 0] }],
    ['NaN 높이', { ...ok, heights: new Float32Array([0, 0, 0, 0, NaN, 0, 0, 0, 0]) }],
    ['Infinity 높이', { ...ok, heights: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, Infinity]) }],
  ];
  for (const [name, t] of bad) {
    assert.throws(() => encodeTerrainTileH32(t), (e) => e instanceof TowerAssetError || e instanceof RangeError, name);
    assert.throws(() => encodeTerrainTileH32(t, { quantize: false }), (e) => e instanceof TowerAssetError || e instanceof RangeError, `${name} (비양자화)`);
  }
  assert.throws(() => encodeTerrainTileH32(ok, { quantize: 1 }), TowerAssetError);
  assert.throws(() => encodeTerrainTileH32(ok, null), TowerAssetError);
  assert.doesNotThrow(() => encodeTerrainTileH32(ok));
});

test('고정 입력 전체 바이트 골든 (cells=3)', () => {
  const heights = new Float32Array([10, 10.05, 10.1, 10.25, 10.5, 10.75, 11, 11.5, 12]);
  // 머리: 48 01 lod=01 flags=01 | tx=-2 | ty=5 | cells=3 | 0 ; base=10 | step=0.05 ; q = 0,1,2,5,10,15,20,30,40
  const q = encodeTerrainTileH32({ tx: -2, ty: 5, lod: 1, cells: 3, heights });
  assert.equal(hex(q), '48010101feffffff050000000300000000002041cdcc4c3d00000100020005000a000f0014001e002800');
  const f = encodeTerrainTileH32({ tx: -2, ty: 5, lod: 0, cells: 3, heights });
  assert.equal(hex(f), '48010000feffffff050000000300000000002041cdcc20419a992141000024410000284100002c41000030410000384100004041');
});
