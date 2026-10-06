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
  assert.equal(h.quantizeHeights(new Float32Array([0, 3276.8])), null); // 기본 step 범위 초과
  assert.ok(h.quantizeHeights(new Float32Array([0, 3276])));
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
