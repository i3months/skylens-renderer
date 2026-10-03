import test from 'node:test';
import assert from 'node:assert/strict';
import { mortonKey, mortonOrder } from './index.mjs';
import { CodecError } from '../../../contracts/codec/index.mjs';

// 결정적 의사난수(mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 독립 느린 구현: BigInt 로 비트 하나씩 끼워 넣는다.
function slowKey(e, n, u) {
  let k = 0n;
  for (let i = 0; i < 16; i++) {
    if ((e >> i) & 1) k |= 1n << BigInt(3 * i);
    if ((n >> i) & 1) k |= 1n << BigInt(3 * i + 1);
    if ((u >> i) & 1) k |= 1n << BigInt(3 * i + 2);
  }
  return Number(k);
}

test('손계산 모턴 키', () => {
  const cases = [
    [[0, 0, 0], 0],
    [[1, 0, 0], 1],
    [[0, 1, 0], 2],
    [[0, 0, 1], 4],
    [[1, 1, 1], 7],
    [[2, 0, 0], 8],
    [[3, 0, 0], 9], // 0b1001
    [[7, 0, 0], 73], // 0b1001001
    [[5, 3, 0], 83], // e 비트0,2 → 1+64, n 비트0,1 → 2+16
    [[0, 0, 255], 9586980], // 4 * (8^8−1)/7
    [[256, 0, 0], 16777216], // 2^24 (상위 부분 경계)
    [[0, 0, 32768], 140737488355328], // 2^47
    [[65535, 65535, 65535], 281474976710655], // 2^48 − 1
  ];
  for (const [[e, n, u], want] of cases) {
    assert.equal(mortonKey(e, n, u), want, `(${e},${n},${u})`);
  }
});

test('mortonKey 가 비트 단위 독립 구현과 무작위 1만 쌍에서 일치', () => {
  const r = rng(12345);
  for (let i = 0; i < 10000; i++) {
    const e = Math.floor(r() * 65536), n = Math.floor(r() * 65536), u = Math.floor(r() * 65536);
    const k = mortonKey(e, n, u);
    assert.equal(k, slowKey(e, n, u), `(${e},${n},${u})`);
    assert.ok(k >= 0 && k < 2 ** 48 && Number.isInteger(k));
  }
});

test('잘못된 입력은 CodecError(stream)', () => {
  const isStream = (err) => err instanceof CodecError && err.code === 'stream';
  assert.throws(() => mortonKey(65536, 0, 0), isStream);
  assert.throws(() => mortonKey(0, -1, 0), isStream);
  assert.throws(() => mortonKey(0, 0, 1.5), isStream);
  assert.throws(() => mortonOrder(new Uint16Array(3), new Uint16Array(3), new Uint16Array(2)), isStream);
  assert.throws(() => mortonOrder(new Uint16Array(2), new Uint16Array(1), new Uint16Array(2)), isStream);
  assert.throws(() => mortonOrder([0, 70000], [0, 0], [0, 0]), isStream);
});

function checkOrder(qe, qn, qu, ord) {
  const n = qe.length;
  assert.ok(ord instanceof Uint32Array);
  assert.equal(ord.length, n);
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    assert.ok(ord[i] < n);
    assert.equal(seen[ord[i]], 0, '중복 인덱스');
    seen[ord[i]] = 1;
  }
  for (let i = 1; i < n; i++) {
    const a = ord[i - 1], b = ord[i];
    const ka = slowKey(qe[a], qn[a], qu[a]), kb = slowKey(qe[b], qn[b], qu[b]);
    assert.ok(ka <= kb, `키 감소 at ${i}`);
    if (ka === kb) assert.ok(a < b, `동률 인덱스 순서 at ${i}`);
  }
}

test('mortonOrder: 순열, 키 비감소, 동률은 인덱스 오름차순', () => {
  // 손으로 정한 작은 예: 키 = [73, 1, 0, 1, 4, 2] → 순서 [2, 1, 3, 5, 4, 0]
  const qe = Uint16Array.from([7, 1, 0, 1, 0, 0]);
  const qn = Uint16Array.from([0, 0, 0, 0, 0, 1]);
  const qu = Uint16Array.from([0, 0, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(mortonOrder(qe, qn, qu)), [2, 1, 3, 5, 4, 0]);
  assert.equal(mortonOrder(new Uint16Array(0), new Uint16Array(0), new Uint16Array(0)).length, 0);
  assert.deepEqual(Array.from(mortonOrder([9], [9], [9])), [0]);

  // 무작위 5000 점, 동률을 많이 만들려고 좁은 범위 + 넓은 범위 섞음.
  const r = rng(777);
  const n = 5000;
  const A = new Uint16Array(n), B = new Uint16Array(n), C = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const wide = r() < 0.5;
    const m = wide ? 65536 : 4;
    A[i] = Math.floor(r() * m);
    B[i] = Math.floor(r() * m);
    C[i] = Math.floor(r() * m);
  }
  const ord = mortonOrder(A, B, C);
  checkOrder(A, B, C, ord);
  // 입력을 바꾸지 않는다 + 결정성.
  const ord2 = mortonOrder(A, B, C);
  assert.deepEqual(ord2, ord);
});

// 합성 지면: 64 m 타일, u16 양자화(1 단위 = 64/65536 m). 높이는 완만한 기복 + 잡음.
function syntheticGround(n, seed) {
  const r = rng(seed);
  const step = 64 / 65536;
  const qe = new Uint16Array(n), qn = new Uint16Array(n), qu = new Uint16Array(n);
  const q = (m) => Math.min(65535, Math.max(0, Math.round(m / step)));
  for (let i = 0; i < n; i++) {
    const x = r() * 64, y = r() * 64;
    const z = 20 + 3 * Math.sin(x / 9) * Math.cos(y / 11) + 0.02 * (r() - 0.5);
    qe[i] = q(x);
    qn[i] = q(y);
    qu[i] = q(z);
  }
  return { qe, qn, qu };
}

// 부호 있는 차분을 지그재그로 바꾼 뒤 LEB128(7 비트씩) 바이트 수.
function lebBytes(d) {
  let v = d < 0 ? -2 * d - 1 : 2 * d; // 지그재그(2^50 미만이라 Number 로 정확)
  let b = 1;
  while (v >= 128) {
    v = Math.floor(v / 128);
    b++;
  }
  return b;
}

function meanDeltaBytes(keys, ord) {
  let sum = lebBytes(keys[ord[0]]);
  for (let i = 1; i < ord.length; i++) sum += lebBytes(keys[ord[i]] - keys[ord[i - 1]]);
  return sum / ord.length;
}

test('20만 점 정렬이 1 초 안쪽이고 결정적(회귀 감시용)', () => {
  const { qe, qn, qu } = syntheticGround(200000, 42);
  const t0 = performance.now();
  const ord = mortonOrder(qe, qn, qu);
  const ms = performance.now() - t0;
  // 회귀 감시: 20만 점 정렬 시간(측정 기준: V8 엔진, M1 MacBook Pro ~40ms)
  assert.ok(ms < 1000, `정렬 ${ms.toFixed(1)} ms`);
  assert.deepEqual(mortonOrder(qe, qn, qu), ord);
  // 키 비감소 확인(빠른 경로).
  let prev = -1;
  for (let i = 0; i < ord.length; i++) {
    const k = mortonKey(qe[ord[i]], qn[ord[i]], qu[ord[i]]);
    assert.ok(k > prev || (k === prev && ord[i] > ord[i - 1]));
    prev = k;
  }
});

test('압축률: 모턴 순 키 차분 LEB128 평균 바이트가 무작위 순 대비 ≤ 0.6 배', () => {
  const n = 200000;
  const { qe, qn, qu } = syntheticGround(n, 2024);
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) keys[i] = mortonKey(qe[i], qn[i], qu[i]);
  // 무작위 순: 생성 순서 자체가 무작위(균일 표본)이므로 항등 순열.
  const ident = new Uint32Array(n);
  for (let i = 0; i < n; i++) ident[i] = i;
  const randomMean = meanDeltaBytes(keys, ident);
  const mortonMean = meanDeltaBytes(keys, mortonOrder(qe, qn, qu));
  // 측정값(시드 2024, 20만 점): 무작위 6.934 B/점, 모턴 3.735 B/점, 비 0.539.
  // 근거: 무작위 순 차분은 2^48 규모라 지그재그 후 49 비트 → 7 바이트가 대부분.
  // 모턴 순은 점당 평균 키 간격이 2^48/20만 ≈ 2^30.4 수준이어도 지면(얇은 u 범위)이라 실제 키는 더 몰려 4 바이트 안팎.
  assert.ok(randomMean >= 6.85 && randomMean <= 7.0, `무작위 ${randomMean}`);
  assert.ok(mortonMean < randomMean);
  assert.ok(mortonMean / randomMean <= 0.6, `비 ${(mortonMean / randomMean).toFixed(3)}`);
  // 회귀 감시: 합성 지면에서 모턴 순 LEB128 평균(측정값 3.735 B/점, 상한 3.85)
  assert.ok(mortonMean <= 3.85, `모턴 ${mortonMean}`);
});
