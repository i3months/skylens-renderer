// 클라이언트 decodeChunkClient 의 오류 의미 시험(F-172 ①②③⑧⑭, F-169). 이 파일은 서버를 import 하지 않는다(client/codec 은 서버 코드와 독립).
// 따라서 "서버와 같음"은 여기서 검증되지 않는다: 기대 코드는 서버 동작을 보고 적어 둔 값일 뿐이라 서버가 바뀌어도 이 시험은 통과한다.
// 서버 decodeChunk 와 같은 입력을 양쪽에 넣어 throw·e.constructor·e.code 를 맞대는 교차 시험은 cross_error.test.mjs 에 있다.
// 시험용 조립기는 이 파일 안에서 계약 형식대로 따로 쓴 것.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeChunkClient } from './index.mjs';
import { serializeHeader, AssetFormatError, OFFSETS } from '../../contracts/asset/index.mjs';
import { CodecError, streamRawBounds } from '../../contracts/codec/index.mjs';

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
/** 저장 모드(mode 0) 컨테이너. rawLen 은 최소 LEB128. */
function stored(raw) {
  const out = [0];
  let x = raw.length;
  do { let b = x & 127; x >>>= 7; if (x) b |= 128; out.push(b); } while (x);
  return Uint8Array.from([...out, ...raw]);
}
/** 임의 바이트 컨테이너([mode][rawLen 최소 LEB][payload]) */
function container(mode, rawLen, payload) {
  const out = [mode];
  let x = rawLen;
  do { let b = x & 127; x >>>= 7; if (x) b |= 128; out.push(b); } while (x);
  return Uint8Array.from([...out, ...payload]);
}
function file(n, colorMode, [a, b, c], hdrOver = {}) {
  const body = new Uint8Array(16 + a.length + b.length + c.length);
  const dv = new DataView(body.buffer);
  body[0] = 1; body[1] = colorMode;
  dv.setUint32(4, a.length, true); dv.setUint32(8, b.length, true); dv.setUint32(12, c.length, true);
  body.set(a, 16); body.set(b, 16 + a.length); body.set(c, 16 + a.length + b.length);
  const hdr = serializeHeader({
    versionMajor: 1, versionMinor: 0, headerSize: 128, format: 1, codec: 1, segmentId: 7, level: 2, pointCount: n,
    tileX: 0, tileY: 0, tileSizeM: 64, lod: 0, quantExp: 10, chunkIndex: 0, bodyBytes: body.length,
    bboxMin: [0, 0, 0], bboxMax: [63.99, 63.99, 63.99], anchor: { lat: 37.5, lon: 127, alt: 30 }, checksum: 0, ...hdrOver,
  });
  const f = new Uint8Array(hdr.length + body.length);
  f.set(hdr); f.set(body, hdr.length);
  new DataView(f.buffer).setUint32(OFFSETS.checksum, crc32(f), true);
  return f;
}
class RangeEnc {
  constructor() { this.low = 0; this.range = 0xffffffff; this.cache = 0; this.cacheSize = 1; this.out = []; this.p = new Uint16Array(256).fill(1024); }
  shiftLow() {
    const lo32 = this.low % 2 ** 32, carry = this.low >= 2 ** 32 ? 1 : 0;
    if (lo32 < 0xff000000 || carry) {
      let t = this.cache;
      do { this.out.push((t + carry) & 255); t = 0xff; } while (--this.cacheSize !== 0);
      this.cache = Math.floor(lo32 / 2 ** 24) & 255;
    }
    this.cacheSize++;
    this.low = (lo32 % 2 ** 24) * 256;
  }
  bit(node, b) {
    const p = this.p[node], bound = (this.range >>> 11) * p;
    if (b === 0) { this.range = bound; this.p[node] = p + ((2048 - p) >> 5); } else { this.low += bound; this.range -= bound; this.p[node] = p - (p >> 5); }
    while (this.range < 2 ** 24) { this.range = (this.range * 256) >>> 0; this.shiftLow(); }
  }
  static encode(raw) {
    const e = new RangeEnc();
    for (const byte of raw) {
      let node = 1;
      for (let i = 7; i >= 0; i--) { const b = (byte >> i) & 1; e.bit(node, b); node = (node << 1) | b; }
    }
    for (let i = 0; i < 5; i++) e.shiftLow();
    return e.out;
  }
}

/** mode 1 컨테이너(범위 부호 payload 를 실제로 부호화) */
const ranged = (raw) => container(1, raw.length, RangeEnc.encode(raw));
const zeros = (k) => new Uint8Array(k);
/** n 점짜리 정상 법선·색(DELTA) 스트림 */
const okNrm = (n) => stored(zeros(2 * n));
const okCol = (n) => stored(zeros(1 + 3 * n));
/** pos 컨테이너만 바꾼 n 점 파일 */
const withPos = (n, pos) => file(n, 0, [pos, okNrm(n), okCol(n)]);
const withNrm = (n, nrm) => file(n, 0, [stored(zeros(n)), nrm, okCol(n)]);
const code = (c) => (e) => e instanceof CodecError && e.code === c;

test('정상 대조: 이 파일의 조립기가 만든 파일은 복호된다', () => {
  const r = decodeChunkClient(withPos(3, stored([5, 6, 7])));
  assert.equal(r.planes.pos_e.length, 3);
});

// ---- ① 범위 복호 실패·LEB128 과길이 = 'stream' ----
test("① pos LEB128 이 7 바이트 넘게 이어지면 'stream'", () => {
  assert.throws(() => decodeChunkClient(withPos(1, stored(new Array(7).fill(0x80)))), code('stream'));
});
test("① normal LEB128 이 3 바이트 넘게 이어지면 'stream'", () => {
  assert.throws(() => decodeChunkClient(withNrm(1, stored([0x80, 0x80, 0x80, 0, 0]))), code('stream'));
});
const msg = (re) => (e) => e instanceof CodecError && e.code === 'stream' && re.test(e.message);
test("① 범위 부호 payload 가 5 바이트 미만이면 'stream'", () => {
  assert.throws(() => decodeChunkClient(withPos(1, container(1, 5, [0, 0, 0]))), msg(/5 바이트 미만/));
});
test("① 범위 부호 첫 바이트가 0 이 아니면 'stream'", () => {
  assert.throws(() => decodeChunkClient(withPos(1, container(1, 5, [1, 0, 0, 0, 0]))), msg(/첫 바이트/));
});
test("① rawLen 이 64×payload+64 를 넘으면(payload 5, rawLen 500, n=100) 'stream'", () => {
  assert.throws(() => decodeChunkClient(file(100, 0, [container(1, 500, [0, 0, 0, 0, 0]), okNrm(100), okCol(100)])), msg(/너무 짧다/));
});
test("① 범위 부호 payload 가 모자라거나 남거나 끝 상태가 어긋나면 'stream'(원인별 메시지)", () => {
  const n = 60;
  const raw = new Array(60).fill(1); raw[0] = 3; // n=60 점, 60 B: 압축돼 payload 가 rawLen 보다 훨씬 짧다
  const ok = ranged(Uint8Array.from(raw));
  const hdr = 2; // mode + rawLen(60 < 128 이라 1 바이트)
  assert.ok(ok.length - hdr < 60 && ok.length - hdr >= 5);
  const mk = (c) => file(n, 0, [c, okNrm(n), okCol(n)]);
  const pos = (c) => decodeChunkClient(mk(c));
  // 1·n 개 점이 아니라 모든 키가 최소 표현이어야 하므로 raw 는 [3,1,1,...] (차분 3,1,1,...) → 정상 대조
  assert.equal(pos(ok).planes.pos_e.length, n);
  assert.throws(() => pos(ok.subarray(0, ok.length - 1)), msg(/모자라다/));
  assert.throws(() => pos(Uint8Array.from([...ok, 0])), msg(/남는다/));
  const bad = ok.slice(); bad[bad.length - 1] ^= 0x55;
  assert.throws(() => pos(bad), msg(/끝 상태|모자라다|남는다/));
});
test("① 진짜 값 범위 위반은 'range' 유지: 모턴 키 ≥ 2^48, 법선 누적 ±127 밖", () => {
  assert.throws(() => decodeChunkClient(withPos(1, stored([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40]))), code('range'));
  assert.throws(() => decodeChunkClient(withNrm(2, stored([0xfe, 0x01, 0xfe, 0x01, 0, 0]))), code('range'));
  // 경계: 누적 127 은 통과(지그재그 254 = FE 01)
  assert.doesNotThrow(() => decodeChunkClient(withNrm(2, stored([0xfe, 0x01, 0, 0, 0]))));
});
test("① 법선 지그재그 값이 u16 을 넘으면 'stream'(서버와 같음)", () => {
  assert.throws(() => decodeChunkClient(withNrm(1, stored([0x80, 0x80, 0x04, 0]))), code('stream'));
});

// ---- ② 위치 LEB128 비최소 표현 ----
test("② 위치 비최소 LEB128([0x80,0x00]=0, [0x81,0x00]=1)은 'stream', 최소 표현은 통과", () => {
  assert.throws(() => decodeChunkClient(withPos(1, stored([0x80, 0x00]))), code('stream'));
  assert.throws(() => decodeChunkClient(withPos(2, stored([0x81, 0x00, 5]))), code('stream'));
  assert.doesNotThrow(() => decodeChunkClient(withPos(2, stored([0x81, 0x01, 5]))));
});

// ---- ③ mode 1 비정규 컨테이너 ----
test("③ mode 1 에서 rawLen 0 은 n=1 의 하한 미달이라 rawLen 범위 검사('limit')가 정규성 검사보다 먼저 걸린다(서버와 같은 순서)", () => {
  assert.throws(() => decodeChunkClient(withPos(1, Uint8Array.from([1, 0]))), code('limit')); // payload 도 0 B
  assert.throws(() => decodeChunkClient(withPos(1, Uint8Array.from([1, 0, 0, 0, 0, 0, 0]))), code('limit'));
});
test("③ mode 1 에서 payloadLen > rawLen 은 'stream', rawLen 이 payload 이상이면 이 검사를 통과한다", () => {
  // rawLen 5, payload 6 → 비정규. 같은 범위 부호 payload 로 rawLen 6 이면 이 검사는 통과하고 뒤 검사(첫 바이트)에서 다른 이유로 걸린다
  assert.throws(() => decodeChunkClient(withPos(1, container(1, 5, [0, 0, 0, 0, 0, 0]))), (e) => e.code === 'stream' && /비정규/.test(e.message));
  assert.throws(() => decodeChunkClient(withPos(1, container(1, 6, [1, 0, 0, 0, 0, 0]))), (e) => e.code === 'stream' && !/비정규/.test(e.message));
});

// ---- ③ rawLen 상한은 계약 streamRawBounds, 밖은 'limit' ----
test("③ streamRawBounds 경계: 하한 미만·상한 초과는 'limit', 경계값은 통과", () => {
  const n = 4;
  const b = streamRawBounds(n);
  assert.deepEqual(b.pos, [4, 28]);
  assert.deepEqual(b.normal, [8, 24]);
  assert.deepEqual(b.color, [9, 782]);
  // pos: 하한 미만 3 → limit, 상한 초과 29 → limit
  assert.throws(() => decodeChunkClient(withPos(n, stored([1, 1, 1]))), code('limit'));
  assert.throws(() => decodeChunkClient(withPos(n, stored(new Array(29).fill(1)))), code('limit'));
  // normal: 7 → limit, 25 → limit
  assert.throws(() => decodeChunkClient(withNrm(n, stored(zeros(7)))), code('limit'));
  assert.throws(() => decodeChunkClient(withNrm(n, stored(zeros(25)))), code('limit'));
  // color: 8 → limit, 783 → limit
  assert.throws(() => decodeChunkClient(file(n, 0, [stored(zeros(n)), okNrm(n), stored(zeros(8))])), code('limit'));
  assert.throws(() => decodeChunkClient(file(n, 0, [stored(zeros(n)), okNrm(n), stored(zeros(783))])), code('limit'));
});
test("③ 서버가 느슨하던 사례: pos rawLen 2^26(n=1) 은 클라이언트도 즉시 'limit'", () => {
  const t0 = performance.now();
  assert.throws(() => decodeChunkClient(withPos(1, container(1, 2 ** 26, [0, 0, 0, 0, 0]))), code('limit'));
  assert.ok(performance.now() - t0 < 50);
});

// ---- ⑧ colorMode ----
test('⑧ 결과에 색 스트림 첫 바이트가 colorMode 로 실린다(0 DELTA, 1 QUANT2, 2 PALETTE), 기존 필드 유지', () => {
  const n = 2;
  const pos = stored([5, 6]), nrm = okNrm(n);
  const delta = decodeChunkClient(file(n, 0, [pos, nrm, stored([0, 1, 2, 3, 4, 5, 6])]));
  assert.equal(delta.colorMode, 0);
  const q2 = decodeChunkClient(file(n, 1, [pos, nrm, stored([1, 2, 2, 10, 0, 6, 2])]));
  assert.equal(q2.colorMode, 1);
  const pal = decodeChunkClient(file(n, 2, [pos, nrm, stored([2, 0, 9, 8, 7, 0, 0])]));
  assert.equal(pal.colorMode, 2);
  assert.deepEqual([...pal.planes.color_r], [9, 9]);
  assert.equal(pal.header.pointCount, 2);
  assert.equal(pal.header.codec, 1);
});

// ---- ⑭ 헤더만 복사 ----
test('⑭ 입력 바이트를 바꾸지 않고(codec 바이트 1 유지), 오프셋 있는 뷰와 같은 결과를 낸다', () => {
  const f = file(2, 0, [stored([5, 6]), okNrm(2), stored([0, 1, 2, 3, 4, 5, 6])]);
  const before = f.slice();
  const a = decodeChunkClient(f);
  assert.deepEqual(f, before);
  assert.equal(f[OFFSETS.codec], 1);
  const big = new Uint8Array(f.length + 11);
  big.set(f, 5);
  const b = decodeChunkClient(big.subarray(5, 5 + f.length));
  assert.deepEqual(b.planes.pos_e, a.planes.pos_e);
  assert.equal(b.header.bodyBytes, f.length - 128);
});
test("⑭ 길이가 header_size+body_bytes 와 다르면 AssetFormatError('body'), 본문 한 바이트 변조는 'checksum'", () => {
  const f = file(2, 0, [stored([5, 6]), okNrm(2), stored([0, 1, 2, 3, 4, 5, 6])]);
  assert.throws(() => decodeChunkClient(f.subarray(0, f.length - 1)), (e) => e instanceof AssetFormatError && e.code === 'body');
  assert.throws(() => decodeChunkClient(Uint8Array.from([...f, 0])), (e) => e instanceof AssetFormatError && e.code === 'body');
  const t = f.slice(); t[f.length - 1] ^= 1;
  assert.throws(() => decodeChunkClient(t), code('checksum'));
  const h = f.slice(); h[OFFSETS.checksum + 4] ^= 1; // 체크섬 필드 바로 뒤 바이트
  assert.throws(() => decodeChunkClient(h), (e) => e.code === 'checksum' || e instanceof AssetFormatError);
  const h2 = f.slice(); h2[OFFSETS.checksum - 1] ^= 1; // 필드 바로 앞 바이트
  assert.throws(() => decodeChunkClient(h2), (e) => e.code === 'checksum' || e instanceof AssetFormatError);
});
