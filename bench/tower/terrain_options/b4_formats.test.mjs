// [cloud] b4_formats 왕복·균열 없음 확인(측정 도구 자체 검증, 계약 시험 아님).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTerrainTile } from '../../../server/terrain/mesh_lod/index.mjs';
import { encodeQuantized, packBits, unpackBits, planarResiduals, planarRestore, quantize } from './b4_formats.mjs';
import { smoothDem, noiseBigDem } from '../lod_bytes.mjs';

test('비트 묶기와 평면 예측은 손실 없이 되돌아온다', () => {
  const vals = Uint32Array.from([0, 1, 2, 3, 7, 5, 0, 6]);
  assert.deepEqual(unpackBits(packBits(vals, 3), vals.length, 3), vals);
  const off = Int32Array.from([5, 6, 8, 4, 4, 9, 1, 0, 3]);
  assert.deepEqual(planarRestore(planarResiduals(off, 3), 3), off);
});

test('양자화 형식: BPO·BPP 복호가 Q16 과 같고 오차 <= step/2(+f32 반올림), 이웃 타일 가장자리 높이가 같다', () => {
  for (const dem of [smoothDem(), noiseBigDem(0)]) {
    for (const lod of [0, 3]) {
      for (const step of [0.01, 0.25]) {
        const a = buildTerrainTile(dem, 0, 0, lod), b = buildTerrainTile(dem, 1, 0, lod);
        const ea = encodeQuantized(a, step, { verify: true }), eb = encodeQuantized(b, step, { verify: true });
        for (let k = 0; k < a.heights.length; k++) assert.ok(Math.abs(ea.heights[k] - a.heights[k]) <= step / 2 + 1e-5);
        const c = a.cells;
        for (let j = 0; j < c; j++) assert.equal(ea.heights[j * c + c - 1], eb.heights[j * c], `가장자리 j=${j}`);
      }
    }
  }
  assert.throws(() => encodeQuantized({ tx: 0, ty: 0, cells: 2, heights: Float32Array.from([0, 0, 0, 1000]) }, 0.01), /overflow/);
  assert.equal(quantize(Float32Array.from([0.004, 0.006]), 0.01).range, 1);
});

test('quantize 와 encodeQuantized 는 비유한 높이·잘못된 step·길이 불일치에서 throw 한다', () => {
  assert.throws(() => quantize([1, NaN, 3], 1), RangeError);
  assert.throws(() => quantize([1, Infinity, 3], 1), RangeError);
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => quantize([1, 2], bad), RangeError, `step ${bad}`);
  assert.equal(quantize([1, 2, 3], 1).range, 2);
  const tile = { tx: 0, ty: 0, cells: 2, heights: Float32Array.from([0, 1, 2]) };
  assert.throws(() => encodeQuantized(tile, 0.01), /cells\^2/);
  assert.ok(encodeQuantized({ ...tile, heights: Float32Array.from([0, 1, 2, 3]) }, 0.01));
});
