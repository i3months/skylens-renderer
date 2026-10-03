// T08.10 퇴화 시점: 희소 배열 구멍과 타입 배열 시험(F-120 ⑥).
// isDegenerateView 는 R 과 t 의 구멍이 있는 희소 배열을 퇴화로 본다. Array.isArray 이므로 Float64Array 는 퇴화.
// 접근자가 던져도 던지지 않고 true 반환.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDegenerateView, assertCameraShape } from './index.mjs';

const good = () => ({
  width: 64,
  height: 48,
  K: { fx: 100, fy: 100, cx: 32, cy: 24 },
  R: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  t: [0, 0, 0],
});

test('R 희소 배열 구멍(undefined)은 퇴화', () => {
  const c = good();
  c.R = new Array(9);
  c.R[0] = 1; c.R[4] = 1; c.R[8] = 1; // 나머지는 undefined(구멍)
  assert.equal(isDegenerateView(c), true);
});

test('R 희소 배열 일부 구멍은 퇴화', () => {
  const c = good();
  c.R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  delete c.R[1]; // 구멍 생성: undefined
  assert.equal(isDegenerateView(c), true);
});

test('t 배열에 명시적 undefined이 있으면 퇴화', () => {
  const c = good();
  c.t = [0, 0, undefined];
  assert.equal(isDegenerateView(c), true);
});

test('t 희소 배열 일부 구멍은 퇴화', () => {
  const c = good();
  c.t = [0, 0, 0];
  delete c.t[1]; // undefined 가 된다
  assert.equal(isDegenerateView(c), true);
});

test('Float64Array R 은 Array.isArray 실패이므로 퇴화', () => {
  const c = good();
  c.R = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(isDegenerateView(c), true);
});

test('Float64Array t 는 Array.isArray 실패이므로 퇴화', () => {
  const c = good();
  c.t = new Float64Array([0, 0, 0]);
  assert.equal(isDegenerateView(c), true);
});

test('Uint8Array R 은 Array.isArray 실패이므로 퇴화', () => {
  const c = good();
  c.R = new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(isDegenerateView(c), true);
});

test('Float32Array t 는 Array.isArray 실패이므로 퇴화', () => {
  const c = good();
  c.t = new Float32Array([0, 0, 0]);
  assert.equal(isDegenerateView(c), true);
});

test('R 의 getter 가 던져도 던지지 않고 true', () => {
  const c = good();
  c.R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  Object.defineProperty(c.R, '0', { get() { throw new Error('getter boom'); } });
  assert.equal(isDegenerateView(c), true);
});

test('t 의 getter 가 던져도 던지지 않고 true', () => {
  const c = good();
  c.t = [0, 0, 0];
  Object.defineProperty(c.t, '1', { get() { throw new Error('getter boom'); } });
  assert.equal(isDegenerateView(c), true);
});

test('width/height 비정수는 퇴화', () => {
  const c = good();
  c.width = 64.5;
  assert.equal(isDegenerateView(c), true);

  const d = good();
  d.height = 48.1;
  assert.equal(isDegenerateView(d), true);
});

test('width*height > 2^26 은 퇴화', () => {
  const c = good();
  // 2^26 = 67108864. width * height > 이 값이면 퇴화.
  c.width = 10000;
  c.height = 7000; // 70000000 > 67108864
  assert.equal(isDegenerateView(c), true);
});

test('width*height = 2^26 경계는 정상', () => {
  const c = good();
  // 2^26 = 67108864
  c.width = 8192;
  c.height = 8192; // 8192 * 8192 = 67108864 (정확히 2^26)
  assert.equal(isDegenerateView(c), false);
});

test('width*height = 8191*8192 는 2^26 보다 작아 정상', () => {
  const c = good();
  c.width = 8191;
  c.height = 8192; // 8191 * 8192 = 67100672 < 67108864
  assert.equal(isDegenerateView(c), false);
});

test('정상 카메라는 퇴화가 아님', () => {
  assert.equal(isDegenerateView(good()), false);
});

test('R 희소 배열 구멍은 assertCameraShape 에서 던짐', () => {
  const c = good();
  c.R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  delete c.R[1]; // 구멍 생성: undefined
  assert.throws(() => assertCameraShape(c), /cull:.*R.*수/);
});

test('t 희소 배열 구멍은 assertCameraShape 에서 던짐', () => {
  const c = good();
  c.t = [0, 0, 0];
  delete c.t[1]; // 구멍 생성: undefined
  assert.throws(() => assertCameraShape(c), /cull:.*t.*수/);
});
