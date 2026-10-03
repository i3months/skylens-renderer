import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeColorStream, decodeColorStream } from './index.mjs';
import { CodecError, COLOR_MODE, COLOR_QUANT2_MEAN_ERR_MAX } from '../../../contracts/codec/index.mjs';

const U = (a) => Uint8Array.from(a);
// 결정적 의사난수(xorshift32)
function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; }; }
const codeOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof CodecError); return e.code; } return null; };

test('DELTA 손계산 바이트열: r 평면, g 평면, b 평면 순 차분 mod 256', () => {
  // 256색 초과가 아니어도 DELTA 를 강제하려면 팔레트가 안 되는 입력이 필요하므로 점 0 개가 아닌 257 색 입력의 앞부분으로 검증한다.
  const n = 257;
  const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  for (let i = 0; i < n; i++) { r[i] = i & 255; g[i] = (i * 3) & 255; b[i] = i >> 8; }
  r[0] = 10; r[1] = 5; // 5-10 = -5 -> 251
  const out = encodeColorStream(r, g, b);
  assert.equal(out[0], 0);
  assert.equal(out.length, 1 + 3 * 257);
  assert.deepEqual([...out.subarray(1, 4)], [10, 251, 253]); // 10, 5-10, 2-5
  assert.deepEqual([...out.subarray(1 + 257, 1 + 257 + 3)], [0, 3, 3]); // g: 0,3,6
  assert.equal(out[1 + 2 * 257 + 256], 1); // b[256]=1, 직전 0
  const d = decodeColorStream(out, n);
  assert.deepEqual(d.r, r); assert.deepEqual(d.g, g); assert.deepEqual(d.b, b);
});

test('PALETTE 손계산 바이트열: 첫 등장 순서 번호', () => {
  const out = encodeColorStream(U([9, 1, 9, 1, 5]), U([8, 2, 8, 2, 6]), U([7, 3, 7, 3, 4]));
  assert.deepEqual([...out], [2, 2, 9, 8, 7, 1, 2, 3, 5, 6, 4, 0, 1, 0, 1, 2]);
  const d = decodeColorStream(out, 5);
  assert.equal(d.mode, COLOR_MODE.PALETTE);
  assert.deepEqual([...d.r], [9, 1, 9, 1, 5]);
});

test('QUANT2 손계산 바이트열: 복원 값 3, 255->254, 130 에 DELTA 적용', () => {
  // v=0->2, 1->2, 3->2, 4->6, 255->254, 130->130
  const out = encodeColorStream(U([0, 255, 4]), U([1, 130, 3]), U([3, 3, 3]), { lossy: true });
  // r 복원 2,254,6 -> 차분 2,252,8(6-254=-248 -> 8)
  // g 복원 2,130,2 -> 차분 2,128,128(2-130=-128 -> 128)
  // b 복원 2,2,2 -> 2,0,0
  assert.deepEqual([...out], [1, 2, 252, 8, 2, 128, 128, 2, 0, 0]);
  const d = decodeColorStream(out, 3);
  assert.equal(d.mode, 1);
  assert.deepEqual([...d.r], [2, 254, 6]);
  assert.deepEqual([...d.g], [2, 130, 2]);
});

test('무작위 색 5만 점 DELTA 왕복 무손실(색 수 256 초과)', () => {
  const n = 50000, rnd = rng(12345);
  const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const v = rnd(); r[i] = v & 255; g[i] = (v >> 8) & 255; b[i] = (v >> 16) & 255; }
  const out = encodeColorStream(r, g, b);
  assert.equal(out[0], COLOR_MODE.DELTA);
  assert.equal(out.length, 1 + 3 * n);
  const d = decodeColorStream(out, n);
  assert.deepEqual(d.r, r); assert.deepEqual(d.g, g); assert.deepEqual(d.b, b);
});

test('무작위 색 5만 점 PALETTE 왕복 무손실(정확히 256 색)', () => {
  const n = 50000, rnd = rng(777);
  const pr = [], pg = [], pb = [];
  for (let k = 0; k < 256; k++) { pr.push(k); pg.push((k * 7 + 1) & 255); pb.push(255 - k); }
  const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const k = i < 256 ? i : rnd() & 255; r[i] = pr[k]; g[i] = pg[k]; b[i] = pb[k]; }
  const out = encodeColorStream(r, g, b);
  assert.equal(out[0], COLOR_MODE.PALETTE);
  assert.equal(out[1], 255);
  assert.equal(out.length, 2 + 3 * 256 + n);
  const d = decodeColorStream(out, n);
  assert.deepEqual(d.r, r); assert.deepEqual(d.g, g); assert.deepEqual(d.b, b);
});

test('QUANT2 균일 무작위 색 평균 절대 오차 <= 2 (이론값 1.0)', () => {
  const n = 50000, rnd = rng(2024);
  const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const v = rnd(); r[i] = v & 255; g[i] = (v >> 8) & 255; b[i] = (v >> 16) & 255; }
  const d = decodeColorStream(encodeColorStream(r, g, b, { lossy: true }), n);
  let sum = 0, max = 0;
  for (let i = 0; i < n; i++) for (const [a, c] of [[r, d.r], [g, d.g], [b, d.b]]) { const e = Math.abs(a[i] - c[i]); sum += e; if (e > max) max = e; }
  const mean = sum / (3 * n);
  assert.ok(mean <= COLOR_QUANT2_MEAN_ERR_MAX);
  assert.ok(Math.abs(mean - 1.0) < 0.02, `평균 ${mean}`);
  assert.equal(max, 2);
});

test('점 0 개는 DELTA 한 바이트', () => {
  const out = encodeColorStream(U([]), U([]), U([]));
  assert.deepEqual([...out], [0]);
  assert.equal(decodeColorStream(out, 0).r.length, 0);
});

test('손상 입력은 CodecError 만', () => {
  assert.equal(codeOf(() => decodeColorStream(U([]), 0)), 'stream');
  assert.equal(codeOf(() => decodeColorStream(U([3, 0, 0, 0]), 1)), 'mode');
  assert.equal(codeOf(() => decodeColorStream(U([0, 1, 2]), 1)), 'stream');
  assert.equal(codeOf(() => decodeColorStream(U([1, 1, 2, 3, 4]), 1)), 'stream');
  assert.equal(codeOf(() => decodeColorStream(U([2]), 1)), 'stream');
  assert.equal(codeOf(() => decodeColorStream(U([2, 1, 1, 2, 3, 4, 5, 6, 0]), 2)), 'stream');
  assert.equal(codeOf(() => decodeColorStream(U([2, 0, 1, 2, 3, 1]), 1)), 'range');
  assert.equal(codeOf(() => encodeColorStream(U([1]), U([1, 2]), U([1]))), 'stream');
  // 임의 바이트 무작위 퍼징: CodecError 외 예외 없음
  const rnd = rng(99);
  for (let t = 0; t < 2000; t++) {
    const len = rnd() % 12, bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = rnd() & 255;
    if (len) bytes[0] &= 3;
    try { decodeColorStream(bytes, rnd() % 6); } catch (e) { assert.ok(e instanceof CodecError); }
  }
});
