// H32 디코더(decodeTerrainTileH32) 시험: 왕복, 골든 바이트, 음성, subarray 오프셋, 별도 복사, 지형 층 연동.
// 시험 안의 작은 바이트 조립기로 계약 형식 바이트를 만든다(클라 시험이 server/ 를 가져오지 않게). 양자화 머리 = i32 kbase · f32 step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTerrainTileH32 } from './decode.mjs';
import { createTerrainLayer } from './index.mjs';
import { quantizeHeights, dequantizeHeights, TERRAIN_H32_STEP_M } from '../../../contracts/tower_assets/terrain_h32.mjs';

/** 계약 머리(+양자화 여분)와 본문으로 바이트를 만든다. 머리 필드는 덮어쓸 수 있다. */
function assemble({ magic = 0x48, version = 2, lod = 0, flags = 0, tx = 0, ty = 0, cells = 3, reserved = 0, base, step, q, heights }) {
  const quant = (flags & 1) !== 0;
  const n = cells * cells;
  const size = 16 + (quant ? 8 + 2 * n : 4 * n);
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, magic); dv.setUint8(1, version); dv.setUint8(2, lod); dv.setUint8(3, flags);
  dv.setInt32(4, tx, true); dv.setInt32(8, ty, true); dv.setUint16(12, cells, true); dv.setUint16(14, reserved, true);
  if (quant) {
    dv.setInt32(16, base, true); dv.setFloat32(20, step, true);
    for (let k = 0; k < n; k++) dv.setUint16(24 + 2 * k, q[k], true);
  } else {
    for (let k = 0; k < n; k++) dv.setFloat32(16 + 4 * k, heights[k], true);
  }
  return buf;
}
const f32 = (a) => Float32Array.from(a);
const ramp = (cells) => f32(Array.from({ length: cells * cells }, (_, k) => Math.fround(k * 0.37 - 3)));

test('비양자화 왕복: 높이가 비트 단위로 같고 머리 필드가 맞다', () => {
  const h = ramp(5);
  const t = decodeTerrainTileH32(assemble({ lod: 0, tx: -7, ty: 12, cells: 5, heights: h }));
  assert.equal(t.tx, -7); assert.equal(t.ty, 12); assert.equal(t.lod, 0); assert.equal(t.cells, 5);
  assert.ok(t.heights instanceof Float32Array);
  assert.deepEqual(Buffer.from(t.heights.buffer), Buffer.from(h.buffer));
});

test('양자화 왕복: 계약 quantizeHeights/dequantizeHeights 와 비트 단위로 같다', () => {
  const h = ramp(9);
  const qz = quantizeHeights(h);
  const t = decodeTerrainTileH32(assemble({ lod: 2, flags: 1, tx: 3, ty: -4, cells: 9, base: qz.base, step: qz.step, q: qz.q }));
  const ref = dequantizeHeights(qz.base, qz.step, qz.q);
  assert.deepEqual(Buffer.from(t.heights.buffer), Buffer.from(ref.buffer));
  for (let k = 0; k < h.length; k++) assert.ok(Math.abs(t.heights[k] - h[k]) <= TERRAIN_H32_STEP_M / 2 + 1e-5);
  assert.equal(t.lod, 2);
});

test('골든 바이트(비양자화): cells=3, tx=-2, ty=5, 높이 0..8', () => {
  const bytes = Uint8Array.from([
    0x48, 0x02, 0x00, 0x00, 0xfe, 0xff, 0xff, 0xff, 0x05, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x40, 0x40,
    0x00, 0x00, 0x80, 0x40, 0x00, 0x00, 0xa0, 0x40, 0x00, 0x00, 0xc0, 0x40, 0x00, 0x00, 0xe0, 0x40,
    0x00, 0x00, 0x00, 0x41,
  ]);
  assert.equal(bytes.length, 52);
  const t = decodeTerrainTileH32(bytes);
  assert.deepEqual({ tx: t.tx, ty: t.ty, lod: t.lod, cells: t.cells }, { tx: -2, ty: 5, lod: 0, cells: 3 });
  assert.deepEqual(Array.from(t.heights), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('골든 바이트(양자화): cells=3, lod=1, kbase=40(i32), step=0.25, q 9개 → 손 계산 (40+q)·0.25', () => {
  const bytes = Uint8Array.from([
    0x48, 0x02, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x03, 0x00, 0x00, 0x00,
    0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3e,
    0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x14, 0x00, 0x64, 0x00, 0xc8, 0x00, 0xe8, 0x03, 0xff, 0xff,
  ]);
  assert.equal(bytes.length, 42);
  const t = decodeTerrainTileH32(bytes);
  assert.deepEqual({ tx: t.tx, ty: t.ty, lod: t.lod, cells: t.cells }, { tx: 1, ty: -1, lod: 1, cells: 3 });
  assert.deepEqual(Array.from(t.heights), [10, 10.25, 10.5, 10.75, 15, 35, 60, 260, 16393.75]);
});

test('골든 바이트(양자화, 음수 kbase): kbase=-3, step=0.5 → -1.5, -1, 32766', () => {
  const bytes = Uint8Array.from([
    0x48, 0x02, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
    0xfd, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x3f,
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0xff, 0xff,
  ]);
  assert.deepEqual(Array.from(decodeTerrainTileH32(bytes).heights), [-1.5, -1, -1, 32766]);
});

test('음성(F-496 ①): lod 0 + 양자화 flag, f32 본문 NaN·Inf, 복원값 비유한은 RangeError', () => {
  assert.throws(() => decodeTerrainTileH32(assemble({ flags: 1, lod: 0, cells: 2, base: 0, step: 0.05, q: [0, 1, 2, 3] })), RangeError);
  assert.throws(() => decodeTerrainTileH32(assemble({ lod: 0, cells: 2, heights: f32([0, NaN, 1, 2]) })), RangeError);
  assert.throws(() => decodeTerrainTileH32(assemble({ lod: 2, cells: 2, heights: f32([0, 1, Infinity, 2]) })), RangeError);
  assert.throws(() => decodeTerrainTileH32(assemble({ lod: 1, cells: 2, heights: f32([-Infinity, 1, 2, 3]) })), RangeError);
  // kbase 2^31−1 · step 3e38 → 복원 Infinity
  assert.throws(() => decodeTerrainTileH32(assemble({ flags: 1, lod: 1, cells: 2, base: 2147483647, step: 3e38, q: [0, 0, 0, 0] })), /유한/);
  assert.throws(() => decodeTerrainTileH32(assemble({ flags: 1, lod: 1, cells: 2, base: 1, step: 3e38, q: [0, 0, 0, 1] })), /유한/);
  assert.throws(() => decodeTerrainTileH32(assemble({ flags: 1, lod: 1, cells: 2, base: 0, step: Infinity, q: [0, 0, 0, 0] })), /step/);
  assert.throws(() => decodeTerrainTileH32(assemble({ flags: 1, lod: 1, cells: 2, base: 0, step: -0.05, q: [0, 0, 0, 0] })), /step/);
});

test('음성: 잘림 여러 길이(0, 15, 머리만, 본문 1 B 모자람)는 던진다', () => {
  const ok = assemble({ cells: 3, heights: ramp(3) });
  for (const len of [0, 1, 15, 16, ok.length - 1]) assert.throws(() => decodeTerrainTileH32(ok.subarray(0, len)), RangeError, `len ${len}`);
  const qz = quantizeHeights(ramp(3));
  const okq = assemble({ flags: 1, lod: 1, cells: 3, base: qz.base, step: qz.step, q: qz.q });
  for (const len of [20, 23, 24, okq.length - 1]) assert.throws(() => decodeTerrainTileH32(okq.subarray(0, len)), RangeError, `q len ${len}`);
});

test('음성: 늘어난 바이트(1 B, 4 B 추가)는 던진다', () => {
  const ok = assemble({ cells: 3, heights: ramp(3) });
  for (const extra of [1, 4]) {
    const big = new Uint8Array(ok.length + extra); big.set(ok);
    assert.throws(() => decodeTerrainTileH32(big), RangeError);
  }
});

test('음성: magic·version·flags·lod·cells·예약이 틀리면 던진다', () => {
  const h = ramp(3);
  assert.throws(() => decodeTerrainTileH32(assemble({ magic: 0x49, heights: h })), /magic/);
  assert.throws(() => decodeTerrainTileH32(assemble({ version: 0, heights: h })), /version/);
  assert.throws(() => decodeTerrainTileH32(assemble({ version: 1, heights: h })), /version/);
  assert.throws(() => decodeTerrainTileH32(assemble({ version: 3, heights: h })), /version/);
  assert.throws(() => decodeTerrainTileH32(assemble({ flags: 2, heights: h })), /flags/);
  assert.throws(() => decodeTerrainTileH32(assemble({ flags: 0x80, heights: h })), /flags/);
  assert.throws(() => decodeTerrainTileH32(assemble({ lod: 4, heights: h })), /lod/);
  assert.throws(() => decodeTerrainTileH32(assemble({ lod: 255, heights: h })), /lod/);
  assert.throws(() => decodeTerrainTileH32(assemble({ reserved: 1, heights: h })), /예약/);
  assert.throws(() => decodeTerrainTileH32(assemble({ cells: 1, heights: f32([0]) })), /cells/);
  assert.throws(() => decodeTerrainTileH32(assemble({ cells: 0, heights: f32([]) })), /cells/);
});

test('음성: 머리 cells 와 실제 본문이 다르면 던진다, 양자화 step 0·NaN step 도 던진다', () => {
  const ok = assemble({ cells: 3, heights: ramp(3) });
  new DataView(ok.buffer).setUint16(12, 4, true); // 머리는 4×4 라고 하나 본문은 3×3
  assert.throws(() => decodeTerrainTileH32(ok), /길이/);
  assert.throws(() => decodeTerrainTileH32(assemble({ flags: 1, lod: 1, cells: 2, base: 0, step: 0, q: [0, 0, 0, 0] })), /step/);
  assert.throws(() => decodeTerrainTileH32(assemble({ flags: 1, lod: 1, cells: 2, base: 0, step: NaN, q: [0, 0, 0, 0] })), /step/);
});

test('음성: 배열·문자열 같은 잘못된 입력 형식은 던진다', () => {
  assert.throws(() => decodeTerrainTileH32([0x48, 1]), RangeError);
  assert.throws(() => decodeTerrainTileH32(null), RangeError);
});

test('ArrayBuffer 입력도 받는다', () => {
  const b = assemble({ cells: 2, heights: f32([1, 2, 3, 4]) });
  const t = decodeTerrainTileH32(b.buffer);
  assert.deepEqual(Array.from(t.heights), [1, 2, 3, 4]);
});

test('subarray: 바이트 오프셋이 4의 배수가 아니어도(1, 2, 3) 같은 결과', () => {
  const qz = quantizeHeights(ramp(4));
  const tiles = [
    assemble({ cells: 4, tx: 9, ty: 8, heights: ramp(4) }),
    assemble({ flags: 1, lod: 3, cells: 4, tx: 9, ty: 8, base: qz.base, step: qz.step, q: qz.q }),
  ];
  for (const tile of tiles) {
    const want = decodeTerrainTileH32(tile);
    for (const off of [1, 2, 3]) {
      const pad = new Uint8Array(off + tile.length + 5); pad.set(tile, off);
      const sub = pad.subarray(off, off + tile.length);
      assert.equal(sub.byteOffset % 4, off);
      const got = decodeTerrainTileH32(sub);
      assert.deepEqual({ ...got, heights: 0 }, { ...want, heights: 0 });
      assert.deepEqual(Buffer.from(got.heights.buffer), Buffer.from(want.heights.buffer));
    }
  }
});

test('반환 heights 는 입력 버퍼와 별도 복사다(입력을 바꿔도 불변, 버퍼 공유 없음)', () => {
  for (const flags of [0, 1]) {
    const qz = quantizeHeights(ramp(3));
    const bytes = assemble({ flags, lod: flags, cells: 3, base: qz.base, step: qz.step, q: qz.q, heights: ramp(3) });
    const t = decodeTerrainTileH32(bytes);
    const snap = Float32Array.from(t.heights);
    assert.notEqual(t.heights.buffer, bytes.buffer);
    assert.equal(t.heights.byteOffset, 0);
    assert.equal(t.heights.buffer.byteLength, 4 * 9);
    bytes.fill(0xff);
    assert.deepEqual(t.heights, snap);
  }
});

test('디코드한 타일이 createTerrainLayer 에 들어가 render 에 그려진다', () => {
  const cells = 3;
  const heights = f32(Array.from({ length: 9 }, (_, k) => (k % cells) * 5)); // 동쪽으로 오르는 경사
  const tile = decodeTerrainTileH32(assemble({ cells, tx: 0, ty: 0, heights }));
  const L = createTerrainLayer();
  assert.equal(L.accept(0, [tile]), 'first');
  assert.deepEqual(L.state(), { level: 0, tileCount: 1, triangleCount: 8 });
  const cam = { width: 64, height: 64, K: { fx: 60, fy: 60, cx: 32, cy: 32 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-32, 32, 80] };
  const out = L.render(cam);
  const painted = Array.from(out.index).filter((v) => v >= 0).length;
  assert.ok(painted > 500, `그려진 화소 ${painted}`);
  assert.ok(Array.from(out.color).some((v) => v !== 0), '색이 모두 0');
});
