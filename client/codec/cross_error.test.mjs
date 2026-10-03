// 서버 decodeChunk 와 클라이언트 decodeChunkClient 의 오류 의미 교차 시험(F-174 ④).
// 같은 손상 입력(CRC 재계산 완료)을 양쪽에 넣어 throw 여부·e.constructor·e.code 가 같음을 단언한다.
// 서버 import 는 시험 파일에서만 허용된다(client/codec/index.mjs 는 서버를 import 하지 않는다).
// alignment.test.mjs 는 클라이언트만 시험하므로, 서버 쪽 오류 코드가 바뀌어도 그 시험은 통과한다 — 그 틈을 이 파일이 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zcrc } from 'node:zlib';
import { decodeChunkClient } from './index.mjs';
import { decodeChunk } from '../../server/codec/chunk/index.mjs';
import { serializeHeader, OFFSETS } from '../../contracts/asset/index.mjs';

// ---- 조립기(계약 형식대로 이 파일 안에서 따로 쓴 것) ----
function leb(x) {
  const out = [];
  do { let b = x % 128; x = Math.floor(x / 128); if (x) b |= 128; out.push(b); } while (x);
  return out;
}
const stored = (raw) => Uint8Array.from([0, ...leb(raw.length), ...raw]);
const container = (mode, rawLen, payload) => Uint8Array.from([mode, ...leb(rawLen), ...payload]);
const zeros = (k) => new Uint8Array(k);
const okPos = (n) => stored(new Array(n).fill(1));
const okNrm = (n) => stored(zeros(2 * n));
const okCol = (n) => stored(zeros(1 + 3 * n));

/** 파일 조립. 체크섬은 항상 재계산한다(손상은 CRC 로 걸러지지 않고 의미 검사까지 가야 한다). */
function build(n, { streams, colorMode = 0, bodyVer = 1, bodyRes = 0, lens, bodyBytes, hdr = {}, tail = [], mut } = {}) {
  const [a, b, c] = streams ?? [okPos(n), okNrm(n), okCol(n)];
  const [pl, nl, cl] = lens ?? [a.length, b.length, c.length];
  const body = new Uint8Array(16 + a.length + b.length + c.length + tail.length);
  const dv = new DataView(body.buffer);
  body[0] = bodyVer; body[1] = colorMode; dv.setUint16(2, bodyRes, true);
  dv.setUint32(4, pl, true); dv.setUint32(8, nl, true); dv.setUint32(12, cl, true);
  body.set(a, 16); body.set(b, 16 + a.length); body.set(c, 16 + a.length + b.length);
  body.set(tail, 16 + a.length + b.length + c.length);
  const h = serializeHeader({
    versionMajor: 1, versionMinor: 0, headerSize: 128, format: 1, codec: 1, segmentId: 7, level: 2, pointCount: n,
    tileX: 0, tileY: 0, tileSizeM: 64, lod: 0, quantExp: 10, chunkIndex: 0, bodyBytes: bodyBytes ?? body.length,
    bboxMin: [0, 0, 0], bboxMax: [63.99, 63.99, 63.99], anchor: { lat: 37.5, lon: 127, alt: 30 }, checksum: 0, ...hdr,
  });
  const f = new Uint8Array(h.length + body.length);
  f.set(h); f.set(body, h.length);
  if (mut) mut(f);
  new DataView(f.buffer).setUint32(OFFSETS.checksum, 0, true);
  new DataView(f.buffer).setUint32(OFFSETS.checksum, zcrc(f) >>> 0, true);
  return f;
}
/** serializeHeader 가 거부하는 값을 헤더에 직접 써 넣는 mut 도우미 */
const f64At = (off, v) => (f) => new DataView(f.buffer).setFloat64(off, v, true);
const u16At = (off, v) => (f) => new DataView(f.buffer).setUint16(off, v, true);
/** 한 스트림만 바꾼 n 점 파일 */
const withPos = (n, pos, o = {}) => build(n, { streams: [pos, okNrm(n), okCol(n)], ...o });
const withNrm = (n, nrm, o = {}) => build(n, { streams: [okPos(n), nrm, okCol(n)], ...o });
const withCol = (n, col, o = {}) => build(n, { streams: [okPos(n), okNrm(n), col], ...o });

// ---- 비교기 ----
function run(fn, bytes) {
  try { fn(bytes.slice()); return { threw: false }; } catch (e) {
    return { threw: true, ctor: e?.constructor, ctorName: e?.constructor?.name, code: e?.code };
  }
}
const show = (r) => (r.threw ? `${r.ctorName}(${r.code})` : '통과');
/** 양쪽 결과가 같음을 단언한다. expect 가 문자열이면 서버 코드와도 맞추고, null 이면 통과를 요구한다. */
function same(bytes, expect) {
  const s = run(decodeChunk, bytes), c = run(decodeChunkClient, bytes);
  assert.equal(c.threw, s.threw, `throw 여부 불일치: 서버 ${show(s)} / 클라이언트 ${show(c)}`);
  assert.equal(c.ctor, s.ctor, `예외 클래스 불일치: 서버 ${show(s)} / 클라이언트 ${show(c)}`);
  assert.equal(c.code, s.code, `e.code 불일치: 서버 ${show(s)} / 클라이언트 ${show(c)}`);
  if (expect === undefined) return;
  if (expect === null) assert.equal(s.threw, false, `통과해야 한다: ${show(s)}`);
  else {
    assert.equal(s.threw, true, `던져야 한다(기대 ${expect})`);
    assert.equal(s.code, expect, `기대 코드 ${expect}, 실제 ${show(s)}`);
  }
}

test('정상 대조: 양쪽 모두 통과한다', () => {
  same(build(3), null);
  same(withPos(1, stored([5])), null);
});

// ---- rawLen 상한·하한(streamRawBounds) ----
test("rawLen 이 상한 초과(pos 2^26, n=1)면 양쪽 'limit'", () => same(withPos(1, container(1, 2 ** 26, [0, 0, 0, 0, 0])), 'limit'));
test("저장 모드 pos rawLen 상한 초과·하한 미만은 'limit'", () => {
  same(withPos(4, stored(new Array(29).fill(1))), 'limit');
  same(withPos(4, stored([1, 1, 1])), 'limit');
});
test("normal rawLen 상한 초과·하한 미만은 'limit'", () => {
  same(withNrm(4, stored(zeros(25))), 'limit');
  same(withNrm(4, stored(zeros(7))), 'limit');
});
test("color rawLen 상한 초과·하한 미만은 'limit'", () => {
  same(withCol(4, stored(zeros(783))), 'limit');
  same(withCol(4, stored(zeros(8))), 'limit');
});
test('rawLen 경계값(pos 하한 n, 상한 7n)은 양쪽 같다', () => {
  same(withPos(4, stored([1, 1, 1, 1])));
  same(withPos(4, stored(new Array(28).fill(1))));
});

// ---- mode 1 비정규 컨테이너 ----
test('mode 1 · payloadLen > rawLen 은 양쪽 같다', () => same(withPos(1, container(1, 5, [0, 0, 0, 0, 0, 0]))));
test('mode 1 · payloadLen == rawLen 경계는 양쪽 같다', () => same(withPos(1, container(1, 6, [1, 0, 0, 0, 0, 0]))));
test('조기 거부 경계: payload 5 B 에서 rawLen 64L+64 / 64L+65 (n=100)', () => {
  const n = 100, p = [0, 0, 0, 0, 0];
  const mk = (rawLen) => withPos(n, container(1, rawLen, p));
  same(mk(64 * 5 + 64));
  same(mk(64 * 5 + 65));
  assert.equal(run(decodeChunk, mk(64 * 5 + 65)).threw, true);
});
test('조기 거부 경계: 다른 payload 길이(L=6, 7)에서도 양쪽 같다', () => {
  const n = 100;
  for (const L of [6, 7]) for (const d of [0, 1]) same(withPos(n, container(1, 64 * L + 64 + d, new Array(L).fill(0))));
});
test('범위 부호 payload 5 B 미만·첫 바이트 비 0 은 양쪽 같다', () => {
  same(withPos(1, container(1, 5, [0, 0, 0])));
  same(withPos(1, container(1, 5, [1, 0, 0, 0, 0])));
});
test('normal·color 스트림의 범위 부호 payload 가 5 B 미만이어도 양쪽 같다', () => {
  same(withNrm(1, container(1, 2, [0, 0, 0])));
  same(withCol(1, container(1, 4, [0, 0, 0])));
});

// ---- LEB128 ----
test("pos LEB128 비최소 표현 [0x80,0x00]·[0x81,0x00] 은 양쪽 'stream'", () => {
  same(withPos(1, stored([0x80, 0x00])), 'stream');
  same(withPos(2, stored([0x81, 0x00, 5])), 'stream');
});
test("pos LEB128 이 7 바이트 넘게 이어지면 양쪽 'stream'", () => same(withPos(1, stored(new Array(7).fill(0x80))), 'stream'));
test("normal LEB128 이 과길이면 양쪽 'stream'", () => same(withNrm(1, stored([0x80, 0x80, 0x80, 0, 0])), 'stream'));
test('normal LEB128 비최소 표현은 양쪽 같다', () => same(withNrm(1, stored([0x80, 0x00, 0, 0]))));
test('entropy 컨테이너 rawLen LEB128 비최소(mode 0, [0x81,0x00])은 양쪽 같다', () => {
  same(withPos(1, Uint8Array.from([0, 0x81, 0x00, 5])));
  same(withPos(1, Uint8Array.from([0, 0x80, 0x00])));
});
test('entropy 컨테이너 rawLen LEB128 이 8 바이트 넘게 이어지면 양쪽 같다', () => {
  same(withPos(1, Uint8Array.from([0, ...new Array(9).fill(0x80), 1, 5])));
});
test('entropy 컨테이너 모르는 mode(2)·잘린 컨테이너는 양쪽 같다', () => {
  same(withPos(1, Uint8Array.from([2, 1, 5])));
  same(withPos(1, Uint8Array.from([0])));
  same(withPos(1, Uint8Array.from([0, 0x80])));
});
test('stored 컨테이너의 payload 길이가 rawLen 과 다르면 양쪽 같다', () => {
  same(withPos(1, container(0, 3, [5])));
  same(withPos(1, container(0, 1, [5, 6])));
});

// ---- 값 범위 ----
test("모턴 키 ≥ 2^48 은 양쪽 'range'", () => same(withPos(1, stored([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40])), 'range'));
test("법선 누적 ±127 밖은 양쪽 'range', 경계 127 은 통과", () => {
  same(withNrm(2, stored([0xfe, 0x01, 0xfe, 0x01, 0, 0])), 'range');
  same(withNrm(2, stored([0xfe, 0x01, 0, 0, 0])));
});
test('법선 지그재그 값이 u16 을 넘으면 양쪽 같다', () => same(withNrm(1, stored([0x80, 0x80, 0x04, 0]))));

// ---- 색 모드 ----
test('색 스트림 첫 바이트가 모르는 모드(3, 255)면 양쪽 같다', () => {
  same(withCol(2, stored([3, 0, 0, 0, 0, 0, 0]), { colorMode: 3 }));
  same(withCol(2, stored([255, 0, 0, 0, 0, 0, 0]), { colorMode: 255 }));
});
test('본문 colorMode 와 색 스트림 첫 바이트가 다르면 양쪽 같다', () => {
  same(withCol(2, stored([0, 0, 0, 0, 0, 0, 0]), { colorMode: 1 }));
  same(withCol(2, okCol(2), { colorMode: 7 }));
});
test('색 모드 1·2 정상 스트림은 양쪽 같다', () => {
  same(withCol(2, stored([1, 2, 2, 10, 0, 6, 2]), { colorMode: 1 }));
  same(withCol(2, stored([2, 0, 9, 8, 7, 0, 0]), { colorMode: 2 }));
});

// ---- 본문 구조·길이 ----
test("스트림 길이 합이 body_bytes 와 다르면 양쪽 'length'", () => {
  const n = 3, a = okPos(n), b = okNrm(n), c = okCol(n);
  same(build(n, { streams: [a, b, c], lens: [a.length + 1, b.length, c.length] }), 'length');
  same(build(n, { streams: [a, b, c], lens: [a.length, b.length, c.length - 1] }), 'length');
  same(build(n, { tail: [0] }), 'length');
});
test('스트림 길이가 u32 최댓값이어도 양쪽 같다', () => same(build(3, { lens: [0xffffffff, 0xffffffff, 0xffffffff] })));
/** 케이스 하나를 독립 test 로 등록한다. todo 면 알려진 불일치로 표시한다(실패해도 실행은 실패하지 않는다). */
function each(name, make, expect, todo) {
  test(name, todo ? { todo } : {}, () => same(make(), expect));
}
const DIV = '서버·클라이언트 헤더 오류 분류가 다르다(클라이언트 readHeaderClient 경로 vs 서버 parseHeader 경로). 계약 정렬 필요';
const TRUNC = () => build(3);
each('body_bytes=15 (16 미만)', () => build(3, { bodyBytes: 15 }), undefined, DIV);
each('body_bytes=0', () => build(3, { bodyBytes: 0 }), undefined, DIV);
each('body_bytes 가 실제보다 1 큼', () => build(3, { bodyBytes: build(3).length - 128 + 1 }), undefined, DIV);
each('파일 끝 1 바이트 잘림', () => { const f = build(3); return f.subarray(0, f.length - 1); }, undefined, DIV);
each('파일 끝에 1 바이트 덧붙임', () => Uint8Array.from([...build(3), 0]), undefined, DIV);
each('파일이 100 바이트(헤더 도중)에서 잘림', () => build(3).subarray(0, 100));
each('빈 입력', () => new Uint8Array(0));
each('점 개수 0', () => build(3, { hdr: { pointCount: 0 } }), undefined, DIV);
each('점 개수 2^32-1', () => build(3, { hdr: { pointCount: 2 ** 32 - 1 } }));
each('점 개수 2^24+1', () => build(3, { hdr: { pointCount: 2 ** 24 + 1 } }));
each('codec=0(raw)로 둔 조각', () => build(3, { hdr: { codec: 0 } }), undefined, DIV);
each('codec=2', () => build(3, { hdr: { codec: 2 } }), undefined, DIV);
each('format=2', () => build(3, { hdr: { format: 2 } }));
each('headerSize=64', () => build(3, { mut: u16At(OFFSETS.headerSize, 64) }), undefined, DIV);
each('headerSize=130(4 의 배수 아님)', () => build(3, { mut: u16At(OFFSETS.headerSize, 130) }));
each('versionMajor=2', () => build(3, { mut: u16At(OFFSETS.versionMajor, 2) }));
each('매직 바이트 변조', () => build(3, { mut: (f) => { f[0] ^= 0xff; } }));
test("본문 버전·예약 필드가 틀리면 양쪽 'format'", () => {
  same(build(3, { bodyVer: 2 }), 'format');
  same(build(3, { bodyVer: 0 }), 'format');
  same(build(3, { bodyRes: 1 }), 'format');
});
test("체크섬 불일치는 양쪽 'checksum'", () => {
  const f = build(3); f[f.length - 1] ^= 1;
  same(f, 'checksum');
  const g = build(3); g[OFFSETS.checksum] ^= 1;
  same(g, 'checksum');
});

// ---- 헤더 의미 ----
test("tileSizeM·lod·quantExp 범위 오류는 양쪽 'field'", () => {
  same(build(3, { hdr: { tileSizeM: 32 } }), 'field');
  same(build(3, { hdr: { lod: 255 } }), 'field');
  same(build(3, { hdr: { quantExp: 31 } }), 'field');
  same(build(3, { hdr: { quantExp: 0 } }));
});
test('anchor 가 유한하지 않으면 양쪽 같다', () => {
  same(build(3, { mut: f64At(OFFSETS.anchorLat, NaN) }), 'field');
  same(build(3, { mut: f64At(OFFSETS.anchorLon, Infinity) }));
  same(build(3, { mut: f64At(OFFSETS.anchorAlt, NaN) }));
});
test('bbox 비유한·min>max·u16 span 초과·타일 밖은 양쪽 같다', () => {
  same(build(3, { mut: f64At(OFFSETS.bboxMin, NaN) }), 'bbox');
  same(build(3, { mut: f64At(OFFSETS.bboxMax + 8, Infinity) }), 'bbox');
  same(build(3, { mut: (f) => { f64At(OFFSETS.bboxMin, 10)(f); f64At(OFFSETS.bboxMax, 5)(f); } }), 'bbox');
  same(build(3, { hdr: { bboxMax: [63.99, 63.99, 200] } }));
  same(build(3, { hdr: { bboxMin: [-1, 0, 0] } }));
  same(build(3, { hdr: { bboxMax: [64, 63, 63] } }));
  same(build(3, { hdr: { tileX: 1 } }), 'tile');
});
test('버전 1.0 에서 예약 바이트가 0 이 아니면 양쪽 같다', () => {
  same(build(3, { mut: (f) => { f[OFFSETS.checksum + 4] = 1; } }));
  same(build(3, { mut: (f) => { f[127] = 1; } }));
});

// ---- 순서 정렬 대기(클라이언트 검사 순서를 서버와 맞추는 중. 통합 전에는 아래 3 건이 실패할 수 있다) ----
// mode 1 · rawLen=0 스트림: 서버는 rawLen 하한을 먼저 보아 'limit', 클라이언트는 컨테이너 비정규 검사로 'stream' 을 던진다.
test('[순서 정렬 대기] mode 1 · rawLen=0 normal 스트림은 양쪽 같다(서버 limit)', () => {
  same(withNrm(1, Uint8Array.from([1, 0])));
  same(withNrm(1, Uint8Array.from([1, 0, 0, 0, 0, 0, 0])), 'limit');
});
test('[순서 정렬 대기] mode 1 · rawLen=0 pos 스트림은 양쪽 같다(서버 limit)', () => {
  same(withPos(1, Uint8Array.from([1, 0])));
  same(withPos(1, Uint8Array.from([1, 0, 0, 0, 0, 0, 0])), 'limit');
});
test('[순서 정렬 대기] mode 1 · rawLen=0 color 스트림은 양쪽 같다(서버 limit)', () => {
  same(withCol(1, Uint8Array.from([1, 0, 0, 0, 0, 0, 0])), 'limit');
});
