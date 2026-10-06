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
  assert.deepEqual(planarRestore(planarResiduals(off, 3), 3, off[0]), off);
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
  assert.throws(() => quantize([], 1), /heights 가 비어 있다/);
  assert.throws(() => quantize(new Float32Array(0), 0), /heights 가 비어 있다/); // 빈 입력 메시지가 step 검사보다 먼저
  const tile = { tx: 0, ty: 0, cells: 2, heights: Float32Array.from([0, 1, 2]) };
  assert.throws(() => encodeQuantized(tile, 0.01), /cells\^2/);
  assert.throws(() => quantize([0, 3e9], 1), RangeError);
  assert.equal(quantize([0, 0x7fffffff], 1).range, 0x7fffffff);
  // 정상 경로: 범위·복원 높이·바이트를 값으로 단언한다(verify 로 왕복도 확인).
  const step = 0.01;
  const src = Float32Array.from([0, 1, 2, 3]);
  const ok = encodeQuantized({ ...tile, heights: src }, step, { verify: true });
  assert.equal(ok.range, 300);
  assert.equal(ok.bitsO, 9);
  assert.equal(ok.heights.length, 4);
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(ok.heights[k] - src[k]) <= step / 2 + 1e-6, `복원 k=${k}`);
  // 반올림 확인: 0.004 → 0, 0.006 → 1 (floor 였다면 둘 다 0).
  assert.deepEqual([...quantize([0.004, 0.006, 0.016], 0.01).off], [0, 1, 2]);
});

test('BPP 는 첫 표본(off[0])을 머리로 두어 큰 첫 값이 비트 폭을 부풀리지 않는다', () => {
  // 평면 경사: off[0]=4. 첫 행·열 잔차는 -1(지그재그 1), 안쪽은 0 — 예전엔 off[0] 의 지그재그 8 때문에 4 비트였다.
  const off = Int32Array.from([4, 3, 2, 3, 2, 1, 2, 1, 0]);
  const e = encodeQuantized({ tx: 0, ty: 0, cells: 3, heights: Float32Array.from(off) }, 1, { verify: true });
  assert.equal(e.range, 4);
  assert.equal(e.bitsP, 1);
  assert.equal(planarResiduals(off, 3)[0], 0);
});
