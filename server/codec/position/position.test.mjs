// T09.1 위치 스트림 시험. 기준값은 손계산·독립 구현(BigInt 비트 단위 모턴 키)·명세 §5.1/§8 수치다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePositionStream, decodePositionStream, positionErrorBoundM } from './index.mjs';
import { packChunk } from '../../asset/pack/index.mjs';
import { ANCHOR } from '../../../fixtures/asset_golden/generate.mjs';
import { CodecError } from '../../../contracts/codec/index.mjs';
import { parseHeader, bodyLayout, HEADER_SIZE, FORMAT_POINT27 } from '../../../contracts/asset/index.mjs';

const u16 = (a) => Uint16Array.from(a);

// 독립 구현: 비트를 하나씩 옮기는 BigInt 모턴 키(본 구현의 표·반쪽 분할과 무관)
function refKey(e, n, u) {
  let k = 0n;
  for (let i = 0; i < 16; i++) {
    k |= BigInt((e >> i) & 1) << BigInt(3 * i);
    k |= BigInt((n >> i) & 1) << BigInt(3 * i + 1);
    k |= BigInt((u >> i) & 1) << BigInt(3 * i + 2);
  }
  return k;
}

// 결정적 의사난수(mulberry32)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 독립 키로 정렬(키 같으면 인덱스 오름차순)한 순열 */
function refOrder(qe, qn, qu) {
  const n = qe.length;
  const keys = new Array(n);
  for (let i = 0; i < n; i++) keys[i] = refKey(qe[i], qn[i], qu[i]);
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b));
  return idx;
}

/** CodecError 만 던지는지(그 밖 예외면 실패) */
function assertCodecError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof CodecError, `CodecError 가 아님: ${err && err.stack}`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

test('손계산: 단위 축 점과 최대 점의 키·바이트열 왕복', () => {
  // 키: (1,0,0)=1, (0,1,0)=2, (0,0,1)=4, (65535,65535,65535)=2^48−1
  // 차분: 1, 1, 2, 2^48−5 = 281474976710651 → LEB128 fb ff ff ff ff ff 3f
  const qe = u16([1, 0, 0, 65535]);
  const qn = u16([0, 1, 0, 65535]);
  const qu = u16([0, 0, 1, 65535]);
  assert.equal(refKey(65535, 65535, 65535), 2n ** 48n - 1n);
  const bytes = encodePositionStream(qe, qn, qu);
  assert.deepEqual([...bytes], [0x01, 0x01, 0x02, 0xfb, 0xff, 0xff, 0xff, 0xff, 0xff, 0x3f]);
  const d = decodePositionStream(bytes, 4);
  assert.deepEqual([...d.qe], [1, 0, 0, 65535]);
  assert.deepEqual([...d.qn], [0, 1, 0, 65535]);
  assert.deepEqual([...d.qu], [0, 0, 1, 65535]);
});

test('손계산: 하위·상위 반쪽 경계와 중복 키', () => {
  // (2,3,1): 비트0 → n,u → 2+4, 비트1 → e,n → 8+16, 키 30
  // (256,0,0): e 비트8 → 키 비트24 = 16777216, 차분 16777186 = 0xFFFFE2 → e2 ff ff 07
  // 같은 점 반복은 차분 0 → 00
  const bytes = encodePositionStream(u16([0, 2, 256, 256]), u16([0, 3, 0, 0]), u16([0, 1, 0, 0]));
  assert.deepEqual([...bytes], [0x00, 0x1e, 0xe2, 0xff, 0xff, 0x07, 0x00]);
  const d = decodePositionStream(bytes, 4);
  assert.deepEqual([...d.qe], [0, 2, 256, 256]);
  assert.deepEqual([...d.qn], [0, 3, 0, 0]);
  assert.deepEqual([...d.qu], [0, 1, 0, 0]);
  // 빈 입력
  assert.equal(encodePositionStream(u16([]), u16([]), u16([])).length, 0);
  const e = decodePositionStream(new Uint8Array(0), 0);
  assert.equal(e.qe.length, 0);
});

test('정렬이 아니면 CodecError(stream), 길이 다르면 CodecError', () => {
  assertCodecError(() => encodePositionStream(u16([0, 1]), u16([1, 0]), u16([0, 0])), 'stream'); // 키 2 → 1
  assertCodecError(() => encodePositionStream(u16([1, 0]), u16([0]), u16([0, 0])));
  assertCodecError(() => encodePositionStream([1], u16([0]), u16([0])));
});

test('무작위 정렬 점 200000 개 왕복 일치(독립 키로 정렬)', () => {
  const N = 200000;
  const r = rng(91);
  const qe = new Uint16Array(N), qn = new Uint16Array(N), qu = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    // 절반은 전 범위, 절반은 좁은 덩어리(작은 차분·중복 키 포함)
    if (i % 2) { qe[i] = r() * 65536; qn[i] = r() * 65536; qu[i] = r() * 65536; }
    else { qe[i] = 30000 + r() * 64; qn[i] = 1000 + r() * 64; qu[i] = r() * 8; }
  }
  const ord = refOrder(qe, qn, qu);
  const se = u16(ord.map((i) => qe[i])), sn = u16(ord.map((i) => qn[i])), su = u16(ord.map((i) => qu[i]));
  const bytes = encodePositionStream(se, sn, su);
  // 차분 최대 7 바이트 → 길이 ≤ 7N, 점마다 최소 1 바이트
  assert.ok(bytes.length >= N && bytes.length <= 7 * N);
  const d = decodePositionStream(bytes, N);
  assert.deepEqual(d.qe, se);
  assert.deepEqual(d.qn, sn);
  assert.deepEqual(d.qu, su);
  // 스트림 첫 키는 독립 키와 같아야 한다(LEB128 직접 해석)
  let k = 0n, sh = 0n, p = 0;
  for (;;) { const b = bytes[p++]; k |= BigInt(b & 0x7f) << sh; sh += 7n; if (b < 0x80) break; }
  assert.equal(k, refKey(se[0], sn[0], su[0]));
});

test('오차 상한 수치(명세 §8)', () => {
  assert.equal(positionErrorBoundM(10), 0.00048828125);
  assert.equal(positionErrorBoundM(9), 0.0009765625);
  assert.equal(positionErrorBoundM(8), 0.001953125);
  assertCodecError(() => positionErrorBoundM(7));
  assertCodecError(() => positionErrorBoundM(11));
});

// quantExp 별 u 축 범위(§5.1): 10 → ≤ 63.999, 9 → ≤ 127.998, 8 → ≤ 255.996. e·n 은 한 타일(64 m) 안.
for (const [qexp, extentU] of [[10, 63.5], [9, 120], [8, 250]]) {
  test(`packChunk 양자화(§5.1) → 스트림 왕복 → 복원 오차 ≤ 상한, 1 cm 미만 (quant_exp ${qexp})`, () => {
    const N = 20000;
    const r = rng(1000 + qexp);
    const positions = new Float32Array(3 * N);
    const normals = new Float32Array(3 * N);
    const colors = new Uint8Array(3 * N);
    for (let i = 0; i < N; i++) {
      positions[3 * i] = 128.25 + r() * 63.5;
      positions[3 * i + 1] = -64 + r() * 63.5;
      positions[3 * i + 2] = -17.3 + r() * extentU;
      normals[3 * i + 2] = 1;
    }
    // 축 범위 양 끝을 정확히 쓰게 한다
    positions[2] = -17.3; positions[5] = -17.3 + extentU;
    const file = packChunk({ format: FORMAT_POINT27, segmentId: 1, level: 0, lod: 0, chunkIndex: 0, anchor: ANCHOR, fields: { positions, normals, colors } });
    const h = parseHeader(file);
    assert.equal(h.quantExp, qexp);
    const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const planes = {};
    for (const p of bodyLayout(FORMAT_POINT27, N).planes) {
      if (!p.name.startsWith('pos_')) continue;
      const a = new Uint16Array(N);
      for (let i = 0; i < N; i++) a[i] = dv.getUint16(HEADER_SIZE + p.offset + 2 * i, true);
      planes[p.name] = a;
    }
    const ord = refOrder(planes.pos_e, planes.pos_n, planes.pos_u);
    const pick = (a) => u16(ord.map((i) => a[i]));
    const bytes = encodePositionStream(pick(planes.pos_e), pick(planes.pos_n), pick(planes.pos_u));
    const d = decodePositionStream(bytes, N);
    const bound = positionErrorBoundM(qexp);
    const step = 2 ** -qexp;
    const qd = [d.qe, d.qn, d.qu];
    let maxErr = 0;
    for (let k = 0; k < N; k++) {
      const i = ord[k];
      for (let a = 0; a < 3; a++) {
        const x = h.bboxMin[a] + qd[a][k] * step; // §6 복원(f64)
        const err = Math.abs(x - positions[3 * i + a]);
        if (err > maxErr) maxErr = err;
      }
    }
    assert.ok(maxErr <= bound, `최대 오차 ${maxErr} > ${bound}`);
    assert.ok(maxErr < 0.01);
    // 무작위 2만 점이면 최대 오차가 반 단계 가까이 가야 한다(양자화가 실제로 일어났는지)
    assert.ok(maxErr > 0.9 * bound, `최대 오차 ${maxErr} 가 너무 작다`);
  });
}

test('손상 입력: 자른·늘린·0xFF 가득·키 ≥ 2^48 은 CodecError 만', () => {
  const r = rng(7);
  const N = 300;
  const qe = new Uint16Array(N), qn = new Uint16Array(N), qu = new Uint16Array(N);
  for (let i = 0; i < N; i++) { qe[i] = r() * 65536; qn[i] = r() * 65536; qu[i] = r() * 65536; }
  const ord = refOrder(qe, qn, qu);
  const pick = (a) => u16(ord.map((i) => a[i]));
  const good = encodePositionStream(pick(qe), pick(qn), pick(qu));
  // 자른 입력: 모든 앞부분
  for (let L = 0; L < good.length; L++) assertCodecError(() => decodePositionStream(good.subarray(0, L), N), 'stream');
  // 늘린 입력: 뒤에 바이트 추가
  for (const extra of [[0], [1], [0x80], [0xff, 0x01], [0, 0, 0]]) {
    const big = new Uint8Array(good.length + extra.length);
    big.set(good); big.set(extra, good.length);
    assertCodecError(() => decodePositionStream(big, N), 'stream');
  }
  // 점 수 불일치
  assertCodecError(() => decodePositionStream(good, N - 1), 'stream');
  assertCodecError(() => decodePositionStream(good, N + 1), 'stream');
  // 0xFF 가득: 이어짐 비트가 7 바이트를 넘는다
  for (const L of [1, 6, 7, 8, 64, 4096]) {
    for (const n of [1, 2, Math.floor(L / 7) || 1, L]) {
      assertCodecError(() => decodePositionStream(new Uint8Array(L).fill(0xff), n), 'stream');
    }
  }
  // 차분 2^48(80 80 80 80 80 80 40) → range, 누적으로 넘는 경우도 range
  assertCodecError(() => decodePositionStream(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40]), 1), 'range');
  assertCodecError(() => decodePositionStream(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x3f, 0x01]), 2), 'range');
  // 잘못된 n·입력 형식
  assertCodecError(() => decodePositionStream(good, -1));
  assertCodecError(() => decodePositionStream(good, 1.5));
  assertCodecError(() => decodePositionStream([1, 2], 2));
  // 무작위 바이트: 성공하거나 CodecError 만
  for (let t = 0; t < 2000; t++) {
    const L = Math.floor(r() * 40);
    const b = new Uint8Array(L);
    for (let i = 0; i < L; i++) b[i] = r() * 256;
    const n = Math.floor(r() * 12);
    try {
      const d = decodePositionStream(b, n);
      assert.equal(d.qe.length, n);
      // 성공했다면 다시 부호화했을 때 같은 키 열(비정규 LEB128 가 아니면 같은 바이트)이어야 한다
      assert.deepEqual(decodePositionStream(encodePositionStream(d.qe, d.qn, d.qu), n), d);
    } catch (err) {
      assert.ok(err instanceof CodecError, `CodecError 가 아님: ${err && err.stack}`);
    }
  }
});
