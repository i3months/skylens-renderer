// T09.2 법선 스트림 시험. 손계산 바이트열, 각 오차(독립 구현과 비교), 왕복, 손상 입력.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodecError } from '../../../contracts/codec/index.mjs';
import { encodeNormalStream, decodeNormalStream, normalAngleErrorDeg } from './index.mjs';

/** 결정적 xorshift32, (0,1) 균등 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
}

const hex = (u8) => Buffer.from(u8).toString('hex');
const i8 = (...v) => Int8Array.from(v);

function expectCodecError(fn, code) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof CodecError, `CodecError 가 아님: ${e && e.name}: ${e && e.message}`);
    if (code) assert.equal(e.code, code);
    return true;
  });
}

test('손계산: oct (0,0),(1,−1),(1,−1) → x 차분 0,1,0 → 지그재그 0,2,0 / y 차분 0,−1,0 → 0,1,0', () => {
  const bytes = encodeNormalStream(i8(0, 1, 1), i8(0, -1, -1));
  assert.equal(hex(bytes), '000200000100');
  const { octX, octY } = decodeNormalStream(Uint8Array.from([0, 2, 0, 0, 1, 0]), 3);
  assert.deepEqual([...octX], [0, 1, 1]);
  assert.deepEqual([...octY], [0, -1, -1]);
});

test('손계산: 극단 차분의 두 바이트 LEB128', () => {
  // x: 127, −127 → 차분 127, −254 → 지그재그 254 = 0xFE→[FE 01], 507 = 0x1FB→[FB 03]
  // y: −127, 127 → 차분 −127, 254 → 지그재그 253→[FD 01], 508 = 0x1FC→[FC 03]
  const bytes = encodeNormalStream(i8(127, -127), i8(-127, 127));
  assert.equal(hex(bytes), 'fe01fb03fd01fc03');
  const { octX, octY } = decodeNormalStream(Uint8Array.from([0xfe, 0x01, 0xfb, 0x03, 0xfd, 0x01, 0xfc, 0x03]), 2);
  assert.deepEqual([...octX], [127, -127]);
  assert.deepEqual([...octY], [-127, 127]);
});

test('손계산: 지그재그 경계 63→7E, 64→80 01(차분 −64 → 127)', () => {
  // x: 63 → 지그재그 126 = 0x7E(한 바이트), 다음 −1 → 차분 −64 → 127 = 0x7F(한 바이트)
  // y: 64 → 128 → [80 01], 다음 64 → 차분 0 → 00
  assert.equal(hex(encodeNormalStream(i8(63, -1), i8(64, 64))), '7e7f800100');
});

test('빈 입력은 빈 스트림', () => {
  assert.equal(encodeNormalStream(new Int8Array(0), new Int8Array(0)).length, 0);
  const r = decodeNormalStream(new Uint8Array(0), 0);
  assert.equal(r.octX.length, 0);
  assert.equal(r.octY.length, 0);
});

test('각 오차 손계산: (1,1,1) → oct (42,42) → 복원 (42,42,43)/√5377, 오차 = acos(127/√(3·5377)) = 0.63799306708…°', () => {
  assert.ok(Math.abs(normalAngleErrorDeg(1, 1, 1) - 0.6379930670858) < 1e-9);
  // 축 방향은 정확히 표현된다
  assert.equal(normalAngleErrorDeg(0, 0, 1), 0);
  assert.equal(normalAngleErrorDeg(0, 0, -1), 0);
  assert.equal(normalAngleErrorDeg(-3, 0, 0), 0);
  assert.equal(normalAngleErrorDeg(0, 2, 0), 0);
});

// 명세 §5.3·§6 을 시험 안에서 따로 구현한 팔면체 부호화·복호화(서버 모듈을 쓰지 않는다)
function refEncode(x, y, z) {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  let u = x / l1;
  let v = y / l1;
  if (z < 0) {
    const nu = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    const nv = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = nu; v = nv;
  }
  const q = (t) => Math.max(-127, Math.min(127, Math.floor(t * 127 + 0.5)));
  return [q(u), q(v)];
}
function refDecode(qx, qy) {
  let u = qx / 127;
  let v = qy / 127;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    const nu = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    const nv = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = nu; v = nv;
  }
  const len = Math.sqrt(u * u + v * v + z * z);
  return [u / len, v / len, z / len];
}

test('무작위 단위 방향 400만 개: 최대 각 오차 ≤ 1.0°(명세 §8, 측정 0.954°), acos 직접 계산과 일치', () => {
  const r = rng(0x12345678);
  const N = 4_000_000;
  let maxErr = 0;
  let maxRef = 0;
  let maxDiff = 0;
  for (let i = 0; i < N; i++) {
    // 가우스 3 성분 → 구 위 균등 방향
    const a = Math.sqrt(-2 * Math.log(r()));
    const b = 2 * Math.PI * r();
    const c = Math.sqrt(-2 * Math.log(r()));
    const d = 2 * Math.PI * r();
    let x = a * Math.cos(b);
    let y = a * Math.sin(b);
    let z = c * Math.cos(d);
    const l = Math.sqrt(x * x + y * y + z * z);
    x /= l; y /= l; z /= l;

    const e = normalAngleErrorDeg(x, y, z);
    const [qx, qy] = refEncode(x, y, z);
    const [bx, by, bz] = refDecode(qx, qy);
    const dot = Math.max(-1, Math.min(1, x * bx + y * by + z * bz));
    const ref = (Math.acos(dot) * 180) / Math.PI;
    const diff = Math.abs(e - ref);
    if (e > maxErr) maxErr = e;
    if (ref > maxRef) maxRef = ref;
    if (diff > maxDiff) maxDiff = diff;
  }
  // acos 는 작은 각에서 약 1e-6° 정밀도라 허용 1e-5°
  assert.ok(maxDiff < 1e-5, `normalAngleErrorDeg 와 acos 독립 계산 차 ${maxDiff}°`);
  assert.ok(maxErr <= 1.0, `최대 각 오차 ${maxErr}° > 1.0°`);
  assert.ok(maxRef <= 1.0, `독립 계산 최대 각 오차 ${maxRef}° > 1.0°`);
  // 이 시드의 측정 최대 0.94835°: 명세 측정(0.954°)과 같은 크기여야 한다(오차를 과소 계산하지 않음)
  assert.ok(maxErr > 0.94, `최대 각 오차 ${maxErr}° 가 너무 작다(측정 0.948°)`);
});

test('무작위 oct 쌍 왕복 무손실(길이 0..2000, 200 회 + 큰 배열 1 회)', () => {
  const r = rng(0xc0ffee);
  const rand = () => Math.floor(r() * 255) - 127; // −127..127
  const run = (n) => {
    const ox = new Int8Array(n);
    const oy = new Int8Array(n);
    for (let i = 0; i < n; i++) { ox[i] = rand(); oy[i] = rand(); }
    const cx = ox.slice();
    const cy = oy.slice();
    const bytes = encodeNormalStream(ox, oy);
    assert.deepEqual(ox, cx, '입력을 바꾸면 안 된다');
    assert.deepEqual(oy, cy, '입력을 바꾸면 안 된다');
    // 값마다 1~2 바이트
    assert.ok(bytes.length >= 2 * n && bytes.length <= 4 * n);
    const { octX, octY } = decodeNormalStream(bytes, n);
    assert.deepEqual(octX, ox);
    assert.deepEqual(octY, oy);
  };
  for (let t = 0; t < 200; t++) run(Math.floor(r() * 2001));
  run(200_000);
});

test('부호화 잘못된 입력은 CodecError', () => {
  expectCodecError(() => encodeNormalStream(i8(-128), i8(0)), 'range');
  expectCodecError(() => encodeNormalStream(i8(0), i8(-128)), 'range');
  expectCodecError(() => encodeNormalStream(i8(0, 1), i8(0)), 'length');
  expectCodecError(() => encodeNormalStream([0], [0]), 'format');
  expectCodecError(() => normalAngleErrorDeg(0, 0, 0), 'range');
  expectCodecError(() => normalAngleErrorDeg(NaN, 0, 1), 'range');
  expectCodecError(() => normalAngleErrorDeg(Infinity, 0, 1), 'range');
});

test('손상 입력: 길이·남는 바이트·LEB128 이상은 stream, 값 범위 밖은 range', () => {
  const u8 = (...v) => Uint8Array.from(v);
  // 모자람
  expectCodecError(() => decodeNormalStream(u8(0, 2, 0, 0, 1), 3), 'stream');
  expectCodecError(() => decodeNormalStream(u8(0x80, 0x80), 1), 'stream'); // 이어짐 비트 뒤 끝
  // 남는 바이트
  expectCodecError(() => decodeNormalStream(u8(0, 2, 0, 0, 1, 0, 0), 3), 'stream');
  // LEB128 4 바이트 이상(u16 초과 길이)
  expectCodecError(() => decodeNormalStream(u8(0x80, 0x80, 0x80, 0x01, 0), 1), 'stream');
  // 3 바이트지만 u16 초과(0x7F 0xFF... → 2^21−1)
  expectCodecError(() => decodeNormalStream(u8(0xff, 0xff, 0x7f, 0), 1), 'stream');
  // 비정규형 LEB128(0 을 두 바이트로)
  expectCodecError(() => decodeNormalStream(u8(0x80, 0x00, 0), 1), 'stream');
  // 점 수 이상
  expectCodecError(() => decodeNormalStream(u8(0, 0), -1), 'stream');
  expectCodecError(() => decodeNormalStream(u8(0, 0), 1.5), 'stream');
  expectCodecError(() => decodeNormalStream(u8(0, 0), NaN), 'stream');
  expectCodecError(() => decodeNormalStream([0, 0], 1), 'stream');
  expectCodecError(() => decodeNormalStream(new Uint8Array(16), (1 << 22) + 1), 'limit');
  // 범위: 지그재그 256 → 차분 128 → 128 > 127
  expectCodecError(() => decodeNormalStream(u8(0x80, 0x02, 0), 1), 'range');
  // 범위: 127 뒤 차분 +1(지그재그 2)
  expectCodecError(() => decodeNormalStream(u8(0xfe, 0x01, 0x02, 0, 0), 2), 'range');
  // 범위: −127 뒤 차분 −1(지그재그 1) — y 평면
  expectCodecError(() => decodeNormalStream(u8(0, 0, 0xfd, 0x01, 0x01), 2), 'range');
});

test('무작위 손상 입력 5만 건: CodecError 외 예외 0, 성공하면 다시 부호화해 같은 바이트', () => {
  const r = rng(0xbadf00d);
  const base = encodeNormalStream(i8(0, 5, -120, 127, 3, -60, 1, 0), i8(-127, 0, 64, -64, 100, 2, -3, 9));
  let ok = 0;
  let bad = 0;
  for (let t = 0; t < 50_000; t++) {
    let bytes;
    const mode = t % 3;
    if (mode === 0) {
      bytes = base.slice();
      const flips = 1 + Math.floor(r() * 3);
      for (let k = 0; k < flips; k++) bytes[Math.floor(r() * bytes.length)] = Math.floor(r() * 256);
    } else if (mode === 1) {
      bytes = base.slice(0, Math.floor(r() * (base.length + 1)));
    } else {
      bytes = new Uint8Array(Math.floor(r() * 40));
      for (let k = 0; k < bytes.length; k++) bytes[k] = Math.floor(r() * 256);
    }
    const n = mode === 2 ? Math.floor(r() * 20) : 8;
    try {
      const { octX, octY } = decodeNormalStream(bytes, n);
      assert.equal(hex(encodeNormalStream(octX, octY)), hex(bytes));
      ok++;
    } catch (e) {
      if (!(e instanceof CodecError)) throw e;
      bad++;
    }
  }
  assert.equal(ok + bad, 50_000);
  assert.ok(bad > 40_000, `거부 수 ${bad}`);
});
