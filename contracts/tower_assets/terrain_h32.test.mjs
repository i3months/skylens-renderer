import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from './terrain_h32.mjs';

test('H32 크기 산식', () => {
  assert.equal(h.terrainH32Bytes(65, false), 16 + 4 * 65 * 65);
  assert.equal(h.terrainH32Bytes(65, true), 24 + 2 * 65 * 65);
});

test('전역 격자: 같은 h 는 타일 최솟값이 달라도 같은 비트로 복원된다', () => {
  const a = h.quantizeHeights(new Float32Array([10, 10.049]));
  const b = h.quantizeHeights(new Float32Array([10.049, 10.024, 7.3]));
  const ra = h.dequantizeHeights(a.kbase, a.step, a.q);
  const rb = h.dequantizeHeights(b.kbase, b.step, b.q);
  assert.notEqual(a.kbase, b.kbase);
  assert.equal(ra[1], rb[0]);
  assert.equal(a.base, a.kbase); // 옛 이름 호환
  // 폴백 격자 반올림도 같은 비트
  assert.equal(h.snapHeightsToGrid(new Float32Array([10.049]))[0], ra[1]);
  // 큰 |h| 에서도 같은 비트
  const big = Math.fround(8123.4567);
  const c = h.quantizeHeights(new Float32Array([big, 8000]));
  const d = h.quantizeHeights(new Float32Array([big, 8200, 8100.01]));
  assert.equal(h.dequantizeHeights(c.kbase, c.step, c.q)[0], h.dequantizeHeights(d.kbase, d.step, d.q)[0]);
});

test('F-494 ④: 격자 범위 65535·step 은 양자화, 65536·step 은 폴백(null)', () => {
  const s = 0.25;
  const okq = h.quantizeHeights(new Float32Array([0, 65535 * s]), s);
  assert.ok(okq);
  assert.equal(okq.kbase, 0);
  assert.equal(okq.q[1], 65535);
  assert.equal(h.dequantizeHeights(okq.kbase, okq.step, okq.q)[1], 16383.75);
  assert.equal(h.quantizeHeights(new Float32Array([0, 65536 * s]), s), null);
  // 음수 쪽 경계
  const neg = h.quantizeHeights(new Float32Array([-1000, -1000 + 65535 * s]), s);
  assert.equal(neg.kbase, -4000);
  assert.equal(h.quantizeHeights(new Float32Array([-1000, -1000 + 65536 * s]), s), null);
});

test('F-494 ⑤: quantizeHeights 음성 — NaN·Inf·step ≤ 0·비유한 step·빈 배열·i32 초과는 null', () => {
  assert.equal(h.quantizeHeights(new Float32Array([0, NaN])), null);
  assert.equal(h.quantizeHeights(new Float32Array([0, Infinity])), null);
  assert.equal(h.quantizeHeights(new Float32Array([1, 2]), 0), null);
  assert.equal(h.quantizeHeights(new Float32Array([1, 2]), -0.05), null);
  assert.equal(h.quantizeHeights(new Float32Array([1, 2]), NaN), null);
  assert.equal(h.quantizeHeights(new Float32Array([1, 2]), Infinity), null);
  assert.equal(h.quantizeHeights(new Float32Array([])), null);
  assert.equal(h.quantizeHeights(new Float32Array([1e9, 1e9]), 0.05), null); // kbase 2e10 > i32
  const s = Math.fround(h.TERRAIN_H32_STEP_M); // 기본 step 범위 경계(계약 상수에서 유도)
  assert.equal(h.quantizeHeights(new Float32Array([0, 65536 * s])), null); // 기본 step 범위 초과
  assert.ok(h.quantizeHeights(new Float32Array([0, 65535 * s])));
  assert.equal(h.snapHeightsToGrid(new Float32Array([NaN])), null);
  assert.equal(h.snapHeightsToGrid(new Float32Array([1]), 0), null);
  assert.throws(() => h.dequantizeHeights(0.5, 0.05, new Uint16Array(1)), RangeError);
});

test('F-494 ⑤·F-496 ②: terrainH32ErrorBoundM 값(f32 반올림 항 제외)', () => {
  assert.equal(h.terrainH32ErrorBoundM(0, false), 0);
  assert.equal(h.terrainH32ErrorBoundM(0.1, false), 0.1);
  assert.equal(h.terrainH32ErrorBoundM(0.1, true), 0.1 + h.TERRAIN_H32_STEP_M / 2);
  assert.equal(h.terrainH32ErrorBoundM(0.2, true, 0.25), 0.325);
  // |h| 작으면 실측 오차 ≤ 상한, 8000 m 대에서는 f32 반올림이 더해질 수 있음을 기록(상한에 그 항이 없다)
  const hs = Float32Array.from({ length: 2000 }, (_, k) => Math.fround(8000 + k * 0.0123));
  const r = h.quantizeHeights(hs);
  const back = h.dequantizeHeights(r.kbase, r.step, r.q);
  let worst = 0;
  for (let k = 0; k < hs.length; k++) worst = Math.max(worst, Math.abs(back[k] - hs[k]));
  assert.ok(worst <= h.terrainH32ErrorBoundM(0, true) + 8000 * 2 ** -23, `worst ${worst}`);
});

test('F-499 ①: snapHeightsToGrid 는 h ∈ (−s/2, 0) 에서 −0 이 아니라 +0 을 낸다', () => {
  const out = h.snapHeightsToGrid(new Float32Array([-0.01, -0.0149, 0, -0]), 0.03);
  for (let k = 0; k < out.length; k++) assert.ok(Object.is(out[k], 0), `[${k}] 비트 ${new Uint32Array(out.buffer)[k].toString(16)}`);
  // 양자화 복원 경로(kbase −1 + q 1 = 0)와 같은 비트
  const qz = h.quantizeHeights(new Float32Array([-0.01, 0.2]), 0.03);
  assert.ok(Object.is(h.dequantizeHeights(qz.kbase, qz.step, qz.q)[0], 0));
});

test('F-499 ③: quantizeHeights kbase 는 floor — 소수부 ≥ 0.5 인 최솟값(명시 step, 손 계산 리터럴)', () => {
  // step 0.5: 10.3/0.5 = 20.6 → floor 20 (round 면 21). 최댓값 12 → kmax 24, q = 0..4
  assert.equal(h.quantizeHeights(new Float32Array([10.3, 12]), 0.5).kbase, 20);
  // step 0.03(f32): 10.049/0.03 ≈ 334.97 → floor 334 (round 면 335)
  assert.equal(h.quantizeHeights(new Float32Array([10.049, 10.5]), 0.03).kbase, 334);
  // 음수: −10.2/0.5 = −20.4 → floor −21 (round 면 −20)
  assert.equal(h.quantizeHeights(new Float32Array([-10.2, -9]), 0.5).kbase, -21);
});

test('F-499 ④: snapHeightsToGrid 복원값이 비유한이면 null', () => {
  assert.equal(h.snapHeightsToGrid([3.4e38], 1.8e38), null); // round(1.89)=2, 2·1.8e38 > f32 최대 → fround Infinity
});

test('F-499 ⑥: dequantizeHeights 는 step 이 유한한 양수가 아니면 RangeError', () => {
  for (const step of [NaN, undefined, 0, -0.03, Infinity, -Infinity, '0.03', null]) {
    assert.throws(() => h.dequantizeHeights(0, step, new Uint16Array(1)), RangeError, `step ${String(step)}`);
  }
  assert.doesNotThrow(() => h.dequantizeHeights(0, 0.03, new Uint16Array(1)));
});
