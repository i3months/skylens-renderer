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
  const bits = new Uint32Array(out.buffer);
  // 양자화 복원 경로(kbase −1 + q 1 = 0)가 내는 값과 비트 비교(+0 삭제 변이에서 snap 만 −0 이 되어 실패한다)
  const qz = h.quantizeHeights(new Float32Array([-0.01, 0.2]), 0.03);
  const ref = h.dequantizeHeights(qz.kbase, qz.step, qz.q)[0];
  assert.equal(new Uint32Array(Float32Array.of(ref).buffer)[0], 0);
  for (let k = 0; k < out.length; k++) assert.ok(Object.is(out[k], ref), `[${k}] 비트 ${bits[k].toString(16)}`);
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
  for (const step of [NaN, undefined, 0, -0.03, Infinity, -Infinity, '0.03', '12', null]) {
    assert.throws(() => h.dequantizeHeights(0, step, new Uint16Array(1)), RangeError, `step ${String(step)}`);
  }
  assert.doesNotThrow(() => h.dequantizeHeights(0, 0.03, new Uint16Array(1)));
});

test('F-502 ①: dequantizeHeights 는 double 0.03 과 fround(0.03) 에서 비트 동일(전 q 범위)', () => {
  const q = Uint16Array.from({ length: 65536 }, (_, k) => k);
  for (const kbase of [0, -1000, 123456]) {
    const a = h.dequantizeHeights(kbase, 0.03, q);
    const b = h.dequantizeHeights(kbase, Math.fround(0.03), q);
    // 65536 원소 deepEqual 은 불일치 시 diff 생성으로 프로세스가 죽으므로 첫 불일치 인덱스로 비교한다.
    const ua = new Uint32Array(a.buffer), ub = new Uint32Array(b.buffer);
    const i = ua.findIndex((v, k) => v !== ub[k]);
    assert.equal(i, -1, `첫 불일치 인덱스 ${i} (kbase ${kbase})`);
  }
});

test('F-502 ⑥: 진입부 음성 — null·undefined·비배열·q 원소 NaN 은 RangeError', () => {
  for (const bad of [null, undefined, 5, {}]) {
    assert.throws(() => h.quantizeHeights(bad), RangeError, `quantize ${String(bad)}`);
    assert.throws(() => h.snapHeightsToGrid(bad), RangeError, `snap ${String(bad)}`);
    assert.throws(() => h.dequantizeHeights(0, 0.03, bad), RangeError, `dequantize ${String(bad)}`);
  }
  assert.throws(() => h.dequantizeHeights(0, 0.03, [0, NaN]), RangeError);
  assert.throws(() => h.dequantizeHeights(0, 0.03, [0, 1.5]), RangeError);
  assert.throws(() => h.dequantizeHeights(0, 0.03, [0, -1]), RangeError);
  assert.throws(() => h.dequantizeHeights(0, 0.03, [65536]), RangeError);
});

test('F-504 ②: step 이 f32 로 0 또는 Infinity 가 되면 RangeError(fround 뒤 재검사)', () => {
  for (const step of [1e-50, 3.5e38]) {
    assert.throws(() => h.dequantizeHeights(0, step, [1, 2]), RangeError, `step ${step}`);
  }
});

test('F-504 ⑤: length 만 있는 유사배열은 세 함수 모두 RangeError', () => {
  const fake = { length: 3 };
  assert.throws(() => h.quantizeHeights(fake), RangeError);
  assert.throws(() => h.snapHeightsToGrid(fake), RangeError);
  assert.throws(() => h.dequantizeHeights(0, 0.03, fake), RangeError);
  assert.throws(() => h.quantizeHeights('abc'), RangeError);
});

test('F-504 ⑥: dequantizeHeights 복원값이 비유한이면 RangeError', () => {
  assert.throws(() => h.dequantizeHeights(2147483647, 3.4e38, [65535]), RangeError);
  assert.doesNotThrow(() => h.dequantizeHeights(0, 3.4e38, [1]));
});

test('F-506 ①: step 이 number 가 아니면 quantize·snap 모두 RangeError(암묵 변환 거부)', () => {
  for (const step of ['0.03', true, null, {}, [0.03], 1n]) {
    assert.throws(() => h.quantizeHeights([1, 2], step), RangeError, `quantize ${String(step)}`);
    assert.throws(() => h.snapHeightsToGrid([1, 2], step), RangeError, `snap ${String(step)}`);
  }
});

test('F-506 ①: quantize 가 돌려주는 step 은 fround(0.03) 와 ===(checkStep fround 제거 변이 M1b)', () => {
  assert.equal(h.quantizeHeights([1, 2], 0.03).step, Math.fround(0.03));
  assert.equal(h.quantizeHeights([1, 2]).step, Math.fround(h.TERRAIN_H32_STEP_M));
  assert.notEqual(Math.fround(0.03), 0.03);
});

test('F-506 ②: DataView 는 세 함수 모두 RangeError(빈 배열처럼 통과 금지)', () => {
  const dv = new DataView(new ArrayBuffer(8));
  assert.throws(() => h.quantizeHeights(dv), RangeError);
  assert.throws(() => h.snapHeightsToGrid(dv), RangeError);
  assert.throws(() => h.dequantizeHeights(0, 0.03, dv), RangeError);
});

test('F-506 ③: quantize 복원값이 비유한이면 null(dequantize 가 던지는 입력은 quantize 도 거른다)', () => {
  assert.equal(h.quantizeHeights([3.4e38], 2e38), null);
  assert.equal(h.quantizeHeights([-3.4e38], 2e38), null);
  assert.throws(() => h.dequantizeHeights(1, 2e38, [1]), RangeError); // kbase 1 + q 1 = 2 → 4e38
  assert.ok(h.quantizeHeights([1e30], 1e30)); // 유한 경계 안쪽은 그대로 양자화
});

test('F-506 ④: {length:0} 유사배열은 RangeError, 3.5e38 step 은 빈 q 에서도 RangeError(M2b)', () => {
  const fake = { length: 0 };
  assert.throws(() => h.quantizeHeights(fake), RangeError);
  assert.throws(() => h.snapHeightsToGrid(fake), RangeError);
  assert.throws(() => h.dequantizeHeights(0, 0.03, fake), RangeError);
  for (const step of [1e-50, 3.5e38]) {
    assert.throws(() => h.dequantizeHeights(0, step, []), RangeError, `step ${step}`);
  }
});

test('F-508: 최소 쪽 복원 검사는 실제 최소 격자 번호 round(min/s)·s 로 한다(floor 한 칸 아래 kbase·s 가 비유한이어도 양자화)', () => {
  const r = h.quantizeHeights([-2.8e38], 2e38);
  assert.notEqual(r, null);
  const d = h.dequantizeHeights(r.kbase, r.step, r.q);
  const g = h.snapHeightsToGrid([-2.8e38], 2e38);
  assert.equal(d[0], g[0]);
  assert.equal(new Uint32Array(d.buffer)[0], new Uint32Array(g.buffer)[0]);
});

test('F-508: 실제 최소 격자 복원값이 f32 범위를 넘으면 null(최소 쪽 검사 제거 변이 M3)', () => {
  assert.equal(h.quantizeHeights([-3.4e38, 0], 2e38), null);
  assert.equal(h.quantizeHeights([-3.4e38, -3.0e38], 2e38), null);
});

test('F-510 ④: BigInt64Array·BigUint64Array 는 세 함수 모두 RangeError', () => {
  for (const A of [BigInt64Array, BigUint64Array]) {
    assert.throws(() => h.quantizeHeights(new A(2), 0.03), RangeError);
    assert.throws(() => h.snapHeightsToGrid(new A(2), 0.03), RangeError);
    assert.throws(() => h.dequantizeHeights(0, 0.03, new A(2)), RangeError);
  }
});
