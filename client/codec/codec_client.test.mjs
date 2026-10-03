// 클라이언트 codec 1 복호기 시험. 시험용 부호화기는 이 파일 안에서 계약 형식대로 따로 쓴 것(서버 코드 미사용).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeChunkClient } from './index.mjs';
import { serializeHeader, AssetFormatError, OFFSETS } from '../../contracts/asset/index.mjs';
import { CodecError, pointMultiset } from '../../contracts/codec/index.mjs';

// ---------- 시험용 부호화기(독립 구현) ----------
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
const ascii = (s) => new TextEncoder().encode(s);

function mortonKey(e, n, u) {
  let k = 0n;
  for (let i = 0n; i < 16n; i++) {
    k |= ((BigInt(e) >> i) & 1n) << (3n * i);
    k |= ((BigInt(n) >> i) & 1n) << (3n * i + 1n);
    k |= ((BigInt(u) >> i) & 1n) << (3n * i + 2n);
  }
  return k;
}
function leb(v, out) {
  let x = BigInt(v);
  do {
    let b = Number(x & 127n);
    x >>= 7n;
    if (x > 0n) b |= 128;
    out.push(b);
  } while (x > 0n);
}
const zz = (d) => (d >= 0 ? 2 * d : -2 * d - 1);
const quant2 = (v) => Math.min(255, ((v >> 2) << 2) + 2);

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

/** entropy 컨테이너. mode 0 저장 / mode 1 범위 부호. 서버 부호기와 같은 규칙: mode 1 은 rawLen > 0 이고 payload ≤ rawLen 일 때만, 아니면 저장 모드로 내려간다. */
function entropy(raw, mode) {
  const out = [0];
  leb(raw.length, out);
  if (mode === 1 && raw.length > 0) {
    const payload = RangeEnc.encode(raw);
    if (payload.length <= raw.length) { out[0] = 1; out.push(...payload); return Uint8Array.from(out); }
  }
  out.push(...raw);
  return Uint8Array.from(out);
}
/** 손상 시험용: payload 크기와 무관하게 mode 1 로 강제한다(정상 부호기는 이런 출력을 만들지 않는다). */
function entropyForcedRange(raw) {
  const out = [1];
  leb(raw.length, out);
  out.push(...RangeEnc.encode(raw));
  return Uint8Array.from(out);
}

/** pts: {e,n,u,r,g,b,x,y}[] → 모턴 정렬(키, 원 인덱스) 후 본문 스트림 원바이트. */
function encodeStreams(pts, colorMode) {
  const idx = pts.map((_, i) => i);
  const keys = pts.map((p) => mortonKey(p.e, p.n, p.u));
  idx.sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b));
  const s = idx.map((i) => pts[i]);
  const pos = [];
  let prev = 0n;
  for (const i of idx) { leb(keys[i] - prev, pos); prev = keys[i]; }
  const nrm = [];
  for (const f of ['x', 'y']) {
    let pv = 0;
    for (const p of s) { leb(zz(p[f] - pv), nrm); pv = p[f]; }
  }
  const col = [colorMode];
  if (colorMode === 2) {
    const m = new Map();
    const ids = [];
    for (const p of s) { const k = (p.r << 16) | (p.g << 8) | p.b; if (!m.has(k)) m.set(k, m.size); ids.push(m.get(k)); }
    assert.ok(m.size <= 256);
    col.push(m.size - 1);
    for (const k of m.keys()) col.push(k >> 16, (k >> 8) & 255, k & 255);
    col.push(...ids);
  } else {
    for (const ch of ['r', 'g', 'b']) {
      let pv = 0;
      for (const p of s) { const v = colorMode === 1 ? quant2(p[ch]) : p[ch]; col.push((v - pv) & 255); pv = v; }
    }
  }
  return { sorted: s, pos: Uint8Array.from(pos), nrm: Uint8Array.from(nrm), col: Uint8Array.from(col) };
}

/** 파일 조립. streams = 이미 entropy 가 입혀진 3 스트림. */
function assemble(n, colorMode, streams, hdrOver = {}, bodyOver = {}) {
  const [a, b, c] = streams;
  const body = new Uint8Array(16 + a.length + b.length + c.length);
  const dv = new DataView(body.buffer);
  body[0] = 1; body[1] = colorMode;
  dv.setUint32(4, bodyOver.posLen ?? a.length, true);
  dv.setUint32(8, bodyOver.nrmLen ?? b.length, true);
  dv.setUint32(12, bodyOver.colLen ?? c.length, true);
  body.set(a, 16); body.set(b, 16 + a.length); body.set(c, 16 + a.length + b.length);
  return fileOf(n, body, hdrOver);
}
function fileOf(n, body, hdrOver = {}) {
  const hdr = serializeHeader({
    versionMajor: 1, versionMinor: 0, headerSize: 128, format: 1, codec: 1, segmentId: 7, level: 2, pointCount: n,
    tileX: 0, tileY: 0, tileSizeM: 64, lod: 0, quantExp: 10, chunkIndex: 0, bodyBytes: body.length,
    bboxMin: [0, 0, 0], bboxMax: [63.99, 63.99, 63.99], anchor: { lat: 37.5, lon: 127, alt: 30 }, checksum: 0, ...hdrOver,
  });
  const file = new Uint8Array(hdr.length + body.length);
  file.set(hdr); file.set(body, hdr.length);
  new DataView(file.buffer).setUint32(OFFSETS.checksum, crc32(file), true);
  return file;
}
const refresh = (file) => { // 체크섬만 다시 계산(내부 손상이 체크섬에 가려지지 않게)
  new DataView(file.buffer, file.byteOffset).setUint32(OFFSETS.checksum, 0, true);
  new DataView(file.buffer, file.byteOffset).setUint32(OFFSETS.checksum, crc32(file), true);
  return file;
};
function encodeFile(pts, { colorMode = 0, ent = 0 } = {}) {
  const st = encodeStreams(pts, colorMode);
  const ents = [entropy(st.pos, ent), entropy(st.nrm, ent), entropy(st.col, ent)];
  const file = assemble(pts.length, colorMode, ents);
  return { file, sorted: st.sorted, modes: ents.map((e) => e[0]) }; // modes: 스트림별 실제 entropy mode(범위 부호가 실제로 쓰였는지 확인용)
}
const rows = (pts, lossy) => pointMultiset({
  pos_e: pts.map((p) => p.e), pos_n: pts.map((p) => p.n), pos_u: pts.map((p) => p.u),
  color_r: pts.map((p) => (lossy ? quant2(p.r) : p.r)), color_g: pts.map((p) => (lossy ? quant2(p.g) : p.g)), color_b: pts.map((p) => (lossy ? quant2(p.b) : p.b)),
  normal_oct_x: pts.map((p) => p.x), normal_oct_y: pts.map((p) => p.y),
});

// 결정적 난수
function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; }; }
function randomPoints(n, seed, { palette = 0 } = {}) {
  const R = rng(seed), ri = (m) => Math.floor(R() * m);
  const pal = Array.from({ length: palette }, () => [ri(256), ri(256), ri(256)]);
  return Array.from({ length: n }, () => {
    const c = palette ? pal[ri(palette)] : [ri(256), ri(256), ri(256)];
    return { e: ri(65536), n: ri(65536), u: ri(65536), r: c[0], g: c[1], b: c[2], x: ri(255) - 127, y: ri(255) - 127 };
  });
}

/** 압축이 잘 되는 점(좁은 격자·좁은 색·좁은 법선)이라 세 스트림 모두 payload ≤ rawLen 이 되어 mode 1 이 실제로 쓰인다. */
function clusteredPoints(n, seed, { palette = 0, span = 16 } = {}) {
  const R = rng(seed), ri = (m) => Math.floor(R() * m);
  const pal = Array.from({ length: palette }, () => [ri(256), ri(256), ri(256)]);
  return Array.from({ length: n }, () => {
    const c = palette ? pal[ri(palette)] : [ri(8) * 2, 100 + ri(4), 200 + ri(2)];
    return { e: ri(span), n: ri(span), u: ri(span), r: c[0], g: c[1], b: c[2], x: ri(5) - 2, y: ri(3) - 1 };
  });
}

// ---------- ① 손으로 만든 골든 ----------
// 점 6 개(모턴 순서): (e,n,u) = (0,0,0)(1,0,0)(0,1,0)(0,0,1)(3,3,3)(256,0,0) → 키 0,1,2,4,63,2^24 → 차분 0,1,1,2,59,16777153 = 00 01 01 02 3B C1 FF FF 07.
const GOLD_BODY = Uint8Array.from([
  0x01, 0x00, 0x00, 0x00, 0x0b, 0, 0, 0, 0x12, 0, 0, 0, 0x15, 0, 0, 0, // 고정부: 버전 1, 색 모드 0, posLen 11, nrmLen 18, colLen 21
  0x00, 0x09, 0x00, 0x01, 0x01, 0x02, 0x3b, 0xc1, 0xff, 0xff, 0x07, // pos: 저장 모드, rawLen 9
  0x00, 0x10, 0x00, 0x0a, 0x0f, 0xf7, 0x01, 0xfc, 0x03, 0xfd, 0x01, // normal x: 0,5,-3,-127,127,0 → 지그재그 0,10,15,247,508,253
  0x00, 0x00, 0x02, 0x03, 0x02, 0xfe, 0x01, //                       normal y: 0,0,1,-1,0,127 → 지그재그 0,0,2,3,2,254
  0x00, 0x13, 0x00, // color: 모드 0
  0x0a, 0x02, 0x00, 0xfd, 0xf6, 0x01, // r = 10,12,12,9,255,0
  0x14, 0x00, 0x00, 0x00, 0x00, 0x00, // g = 20 x6
  0x00, 0xff, 0x01, 0xff, 0x01, 0xff, // b = 0,255,0,255,0,255
]);
const GOLD_EXPECT = {
  pos_e: [0, 1, 0, 0, 3, 256], pos_n: [0, 0, 1, 0, 3, 0], pos_u: [0, 0, 0, 1, 3, 0],
  color_r: [10, 12, 12, 9, 255, 0], color_g: [20, 20, 20, 20, 20, 20], color_b: [0, 255, 0, 255, 0, 255],
  normal_oct_x: [0, 5, -3, -127, 127, 0], normal_oct_y: [0, 0, 1, -1, 0, 127],
};

test('CRC-32 시험값 123456789 와 abc (시험용 구현 자체 확인)', () => {
  assert.equal(crc32(ascii('123456789')), 0xcbf43926);
  assert.equal(crc32(ascii('abc')), 0x352441c2);
});

test('골든: 손으로 만든 codec 1 파일(entropy 저장 모드) 복호 값', () => {
  const file = fileOf(6, GOLD_BODY);
  assert.equal(file.length, 194);
  const { header, planes } = decodeChunkClient(file);
  assert.equal(header.codec, 1);
  assert.equal(header.pointCount, 6);
  assert.equal(header.bodyBytes, 66);
  for (const [k, want] of Object.entries(GOLD_EXPECT)) assert.deepEqual(Array.from(planes[k]), want, k);
  assert.ok(planes.pos_e instanceof Uint16Array && planes.color_g instanceof Uint8Array && planes.normal_oct_x instanceof Int8Array);
  // 체크섬 고정값(파일 바이트가 바뀌면 이 값도 바뀐다)
  assert.equal(new DataView(file.buffer).getUint32(OFFSETS.checksum, true), CRC_GOLD);
});
const CRC_GOLD = 0x724101b5; // 이 골든 파일(헤더 포함 194 B)의 CRC-32

// 범위 부호 골든. 6 점을 각각 8 번 연속 반복한 48 점(같은 키의 차분은 0)의 pos 원스트림은 손으로 쓴다:
//   키 차분 0,1,1,2,59,16777153 각각 뒤에 0 이 7 개 → 00 +7×00, 01 +7×00, 01 +7×00, 02 +7×00, 3B +7×00, C1 FF FF 07 +7×00 (51 B).
// 이 51 B 를 LZMA 방식(prob 11 비트·초기 1024, 이동 5, 첫 바이트 0, 5 바이트 flush)으로 부호화한 payload(압축되어 51 B 이하)를 16 진으로 고정한다.
const POS_RAW_HEX = '00' + '00'.repeat(7) + '01' + '00'.repeat(7) + '01' + '00'.repeat(7) + '02' + '00'.repeat(7) + '3b' + '00'.repeat(7) + 'c1ffff07' + '00'.repeat(7);
const POS_RANGE_PAYLOAD_HEX = '00000000000000000901a4a4000d7132823f709eb57b2e4b565dfb15291f000000';
test('골든: 범위 부호(mode 1) 고정 바이트열 복호', () => {
  const rawPos = Uint8Array.from(Buffer.from(POS_RAW_HEX, 'hex'));
  assert.equal(rawPos.length, 51);
  const payload = Uint8Array.from(Buffer.from(POS_RANGE_PAYLOAD_HEX, 'hex'));
  assert.ok(payload.length <= rawPos.length, `payload ${payload.length} B 는 rawLen 51 이하여야 mode 1 이 정규`);
  // 시험 부호화기가 같은 바이트열을 만드는지(부호화기·복호기 상호 확인)
  assert.deepEqual(Array.from(RangeEnc.encode(rawPos)), Array.from(payload));
  const posStream = Uint8Array.from([0x01, 51, ...payload]); // mode 1, rawLen 51
  const pts = [];
  const exp = {};
  for (const k of Object.keys(GOLD_EXPECT)) exp[k] = GOLD_EXPECT[k].flatMap((v) => Array(8).fill(v));
  for (let i = 0; i < 6; i++) {
    for (let r = 0; r < 8; r++) pts.push({ e: GOLD_EXPECT.pos_e[i], n: GOLD_EXPECT.pos_n[i], u: GOLD_EXPECT.pos_u[i], r: GOLD_EXPECT.color_r[i], g: GOLD_EXPECT.color_g[i], b: GOLD_EXPECT.color_b[i], x: GOLD_EXPECT.normal_oct_x[i], y: GOLD_EXPECT.normal_oct_y[i] });
  }
  const st = encodeStreams(pts, 0);
  assert.equal(Buffer.from(st.pos).toString('hex'), POS_RAW_HEX); // 손으로 쓴 원스트림과 시험 부호화기 출력이 같다
  const file = assemble(48, 0, [posStream, entropy(st.nrm, 0), entropy(st.col, 0)]);
  const { planes } = decodeChunkClient(file);
  for (const [k, want] of Object.entries(exp)) assert.deepEqual(Array.from(planes[k]), want, k);
  // payload 한 바이트 변조는 거부된다(끝 상태 또는 값 범위)
  const bad = Uint8Array.from(posStream); bad[bad.length - 1] ^= 1;
  rejects(assemble(48, 0, [bad, entropy(st.nrm, 0), entropy(st.col, 0)]), CodecError, 'stream');
});

// ---------- ② 무작위 1만 점 왕복 ----------
for (const [name, opts, pal, lossy] of [
  ['저장 모드·색 DELTA', { colorMode: 0, ent: 0 }, 0, false],
  ['범위 부호·색 DELTA', { colorMode: 0, ent: 1 }, 0, false],
  ['범위 부호·색 QUANT2', { colorMode: 1, ent: 1 }, 0, true],
  ['범위 부호·색 PALETTE(40색)', { colorMode: 2, ent: 1 }, 40, false],
  ['저장 모드·색 PALETTE(256색)', { colorMode: 2, ent: 0 }, 256, false],
]) {
  test(`무작위 점 1만 개 왕복: ${name}`, () => {
    const gen = opts.ent === 1 ? clusteredPoints : randomPoints; // 범위 부호 시험은 압축되는 점 분포(아니면 저장 모드로 내려가 시험이 되지 못한다)
    const pts = gen(10000, 12345 + opts.colorMode * 7 + opts.ent, { palette: pal });
    const { file, sorted, modes } = encodeFile(pts, opts);
    if (opts.ent === 1) assert.deepEqual(modes, [1, 1, 1], '세 스트림 모두 실제로 범위 부호가 쓰여야 한다');
    else assert.deepEqual(modes, [0, 0, 0]);
    const { header, planes } = decodeChunkClient(file);
    assert.equal(header.pointCount, 10000);
    assert.equal(planes.pos_e.length, 10000);
    // 다중집합 동일
    const got = pointMultiset(planes);
    assert.deepEqual(got, rows(pts, lossy));
    // 점 순서 = 모턴 키 오름차순(시험 부호화기가 정렬한 순서와 위치별로 같다)
    for (let i = 0; i < 10000; i++) {
      assert.equal(planes.pos_e[i], sorted[i].e);
      assert.equal(planes.pos_n[i], sorted[i].n);
      assert.equal(planes.pos_u[i], sorted[i].u);
    }
    for (let i = 1; i < 10000; i++) {
      assert.ok(mortonKey(planes.pos_e[i], planes.pos_n[i], planes.pos_u[i]) >= mortonKey(planes.pos_e[i - 1], planes.pos_n[i - 1], planes.pos_u[i - 1]));
    }
  });
}

test('경계값: 모서리 점·중복 점(같은 키는 차분 0)', () => {
  const pts = [
    { e: 65535, n: 65535, u: 65535, r: 255, g: 255, b: 255, x: 127, y: -127 },
    { e: 0, n: 0, u: 0, r: 0, g: 0, b: 0, x: -127, y: 127 },
    { e: 65535, n: 65535, u: 65535, r: 1, g: 2, b: 3, x: 0, y: 0 },
  ];
  // 모서리 3 점 자체는 너무 작아 저장 모드로 내려가므로(정상 규칙), 같은 점들을 반복해 중복 점이 많은 범위 부호 스트림도 시험한다
  const { file: small3, modes: m3 } = encodeFile(pts, { colorMode: 0, ent: 1 });
  assert.deepEqual(m3, [0, 0, 0]);
  const { planes } = decodeChunkClient(small3);
  assert.deepEqual(pointMultiset(planes), rows(pts, false));
  assert.equal(planes.pos_e[0], 0);
  assert.equal(planes.pos_u[2], 65535);
  const many = [...pts, ...Array.from({ length: 300 }, (_, i) => ({ ...pts[i % 3] }))];
  const { file, modes } = encodeFile(many, { colorMode: 0, ent: 1 });
  assert.equal(modes[0], 1, 'pos 스트림은 범위 부호여야 한다');
  const big = decodeChunkClient(file).planes;
  assert.deepEqual(pointMultiset(big), rows(many, false));
  assert.equal(big.pos_e[0], 0);
  assert.equal(big.pos_u[302], 65535);
});

test('codec 0 파일은 readPlanesClient 에 위임', async () => {
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync(new URL('../../fixtures/asset_golden/point27.skla', import.meta.url)));
  const { header, planes } = decodeChunkClient(bytes);
  assert.equal(header.codec, 0);
  assert.equal(planes.pos_e.length, 32);
  assert.equal(planes.pos_e[31], 3584);
});

// ---------- ③ 거부 ----------
const small = () => encodeFile(randomPoints(50, 99), { colorMode: 0, ent: 1 }).file;
const rejects = (file, cls, code) => assert.throws(() => decodeChunkClient(file), (e) => e instanceof cls && (!code || e.code === code), `${cls.name} ${code}`);

test('거부: 체크섬 불일치(본문 한 비트)', () => {
  const f = small();
  f[f.length - 1] ^= 1;
  rejects(f, CodecError, 'checksum');
});
test('거부: 체크섬 필드 변조', () => {
  const f = small();
  f[OFFSETS.checksum] ^= 0x80;
  rejects(f, CodecError, 'checksum');
});
test('거부: 스트림 길이 합 != body_bytes', () => {
  const st = encodeStreams(randomPoints(50, 5), 0);
  const s = [entropy(st.pos, 0), entropy(st.nrm, 0), entropy(st.col, 0)];
  rejects(assemble(50, 0, s, {}, { posLen: s[0].length + 1 }), CodecError, 'length');
  rejects(assemble(50, 0, s, {}, { colLen: s[2].length - 1 }), CodecError, 'length');
});
test('거부: body_bytes 가 고정부(16)보다 작다', () => {
  rejects(fileOf(5, new Uint8Array(8)), CodecError, 'length');
});
test('거부: 본문 버전·예약 필드', () => {
  const f = small();
  f[128] = 2;
  rejects(refresh(f), CodecError, 'format');
  const g = small();
  g[130] = 1;
  rejects(refresh(g), CodecError, 'format');
});
test('거부: 색 모드 불명(본문 바이트와 스트림 첫 바이트)', () => {
  const st = encodeStreams(randomPoints(50, 6), 0);
  const ents = [entropy(st.pos, 0), entropy(st.nrm, 0)];
  // 본문 색 모드 7, 스트림 첫 바이트도 7
  const badCol = st.col.slice(); badCol[0] = 7;
  rejects(assemble(50, 7, [...ents, entropy(badCol, 0)]), CodecError, 'mode');
  // 본문 모드 0 인데 스트림 첫 바이트 2(알려진 모드지만 불일치)
  const mis = st.col.slice(); mis[0] = 2;
  rejects(assemble(50, 0, [...ents, entropy(mis, 0)]), CodecError, 'mode');
});
test('거부: entropy 모드 불명', () => {
  const st = encodeStreams(randomPoints(50, 7), 0);
  const bad = entropy(st.pos, 0); bad[0] = 2;
  rejects(assemble(50, 0, [bad, entropy(st.nrm, 0), entropy(st.col, 0)]), CodecError, 'mode');
});
test('거부: rawLen 부풀림(저장 길이 불일치·상한 초과·범위 부호 모자람)', () => {
  const st = encodeStreams(randomPoints(50, 8), 0);
  const rest = [entropy(st.nrm, 0), entropy(st.col, 0)];
  const ok = entropy(st.pos, 0); // [0][LEB rawLen][raw]
  const lebLen = ok[1] & 128 ? 2 : 1;
  const raw = Array.from(ok.subarray(1 + lebLen));
  // 저장 모드에서 rawLen 만 300 으로(상한 7*50=350 이내라 길이 불일치로 거부)
  rejects(assemble(50, 0, [Uint8Array.from([0, 0xac, 0x02, ...raw]), ...rest]), CodecError, 'stream');
  // 상한 초과: rawLen = 2^28
  rejects(assemble(50, 0, [Uint8Array.from([0, 0x80, 0x80, 0x80, 0x80, 0x01]), ...rest]), CodecError, 'limit');
  // rawLen = 352 > 350
  rejects(assemble(50, 0, [Uint8Array.from([0, 0xe0, 0x02, ...raw]), ...rest]), CodecError, 'limit');
  // 범위 부호에서 rawLen 만 328(상한 이내, 실제보다 큼): 범위 복호가 실패하므로 'stream'(클라이언트도 'range' 아님)
  // 압축되는 점(payload ≤ rawLen)으로 만들어야 비정규 컨테이너 검사가 아니라 범위 복호 실패 경로를 시험한다.
  const cs = encodeStreams(clusteredPoints(50, 8, { span: 2 }), 0);
  const rg = entropyForcedRange(cs.pos);
  const rl = rg[1] & 128 ? 2 : 1;
  const payload = rg.subarray(1 + rl);
  assert.ok(cs.pos.length < 328 && payload.length <= cs.pos.length, `payload ${payload.length} B, raw ${cs.pos.length} B`);
  assert.equal(rg[0], 1);
  assert.doesNotThrow(() => decodeChunkClient(assemble(50, 0, [rg, entropy(cs.nrm, 0), entropy(cs.col, 0)]))); // 정상 대조
  rejects(assemble(50, 0, [Uint8Array.from([1, 0xc8, 0x02, ...payload]), entropy(cs.nrm, 0), entropy(cs.col, 0)]), CodecError, 'stream');
});
test('거부: 범위 부호 payload 가 남거나 첫 바이트 비 0', () => {
  const st = encodeStreams(clusteredPoints(50, 9), 0);
  const ok = entropyForcedRange(st.pos);
  assert.ok(ok.length - 2 <= st.pos.length, '정상 대조: payload ≤ rawLen 이라야 mode 1 이 정규'); // 헤더 = mode 1 B + rawLen LEB 1 B
  assert.doesNotThrow(() => decodeChunkClient(assemble(50, 0, [ok, entropy(st.nrm, 0), entropy(st.col, 0)])));
  const more = Uint8Array.from([...ok, 0]);
  rejects(assemble(50, 0, [more, entropy(st.nrm, 0), entropy(st.col, 0)]), CodecError, 'stream');
  const hdrLen = 1 + (ok[1] & 128 ? 2 : 1);
  const nz = ok.slice(); nz[hdrLen] = 1;
  rejects(assemble(50, 0, [nz, entropy(st.nrm, 0), entropy(st.col, 0)]), CodecError, 'stream');
});
test('거부: pos 스트림 키 2^48 이상·모자람·남음', () => {
  const n = 2;
  const nrm = entropy(Uint8Array.from([0, 0, 0, 0]), 0), col = entropy(Uint8Array.from([0, 0, 0, 0, 0, 0, 0]), 0);
  const big = []; leb(2n ** 48n, big); big.push(0);
  rejects(assemble(n, 0, [entropy(Uint8Array.from(big), 0), nrm, col]), CodecError, 'range');
  rejects(assemble(n, 0, [entropy(Uint8Array.from([5]), 0), nrm, col]), CodecError, 'limit'); // 점마다 최소 1 B(streamRawBounds 하한 2) 미달
  rejects(assemble(n, 0, [entropy(Uint8Array.from([5, 0x80]), 0), nrm, col]), CodecError, 'stream'); // 길이는 하한이지만 둘째 LEB128 이 잘림
  rejects(assemble(n, 0, [entropy(Uint8Array.from([5, 6, 7]), 0), nrm, col]), CodecError, 'stream'); // 남음
  // 정상 대조: 2 점
  assert.doesNotThrow(() => decodeChunkClient(assemble(n, 0, [entropy(Uint8Array.from([5, 6]), 0), nrm, col])));
});
test('거부: payload 가 rawLen 보다 큰 mode 1 은 범위 복호로 풀리는 스트림이라도 비정규라 거부', () => {
  // 0x00 한 바이트의 범위 부호는 손계산상 payload 6 B(전부 0x00)이고 그 자체로는 정확히 복호된다. 그래도 6 > rawLen 1 이라 비정규.
  assert.deepEqual(RangeEnc.encode(Uint8Array.of(0)), [0, 0, 0, 0, 0, 0]);
  const nrm = entropy(Uint8Array.from([0, 0]), 0), col = entropy(Uint8Array.from([0, 0, 0, 0]), 0);
  const odd = assemble(1, 0, [Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 0]), nrm, col]);
  rejects(odd, CodecError, 'stream');
  // 같은 점을 저장 모드로 쓰면 정상 복호(대조)
  assert.doesNotThrow(() => decodeChunkClient(assemble(1, 0, [entropy(Uint8Array.of(0), 0), nrm, col])));
  // rawLen 0 인 mode 1 도 'stream'(저장 모드 rawLen 0 이 정규)
  rejects(assemble(1, 0, [Uint8Array.from([1, 0, 0, 0, 0, 0, 0]), nrm, col]), CodecError, 'stream');
});
test('거부: normal 값 범위 밖(누적 128)', () => {
  const col = entropy(Uint8Array.from([0, 0, 0, 0, 0, 0, 0]), 0);
  const pos = entropy(Uint8Array.from([0, 0]), 0);
  // x: 차분 +127 두 번 → 254 > 127.  지그재그 254 = FE 01
  const x = [0xfe, 0x01, 0xfe, 0x01], y = [0, 0];
  rejects(assemble(2, 0, [pos, entropy(Uint8Array.from([...x, ...y]), 0), col]), CodecError, 'range');
});
test('거부: format 2 를 codec 1 로 쓴 파일', () => {
  const st = encodeStreams(randomPoints(10, 10), 0);
  const f = assemble(10, 0, [entropy(st.pos, 0), entropy(st.nrm, 0), entropy(st.col, 0)], { format: 2 });
  rejects(f, CodecError, 'format');
});
test('거부: 팔레트 인덱스 범위 밖·길이 불일치', () => {
  const st = encodeStreams(randomPoints(3, 11), 0);
  const e = [entropy(st.pos, 0), entropy(st.nrm, 0)];
  rejects(assemble(3, 2, [...e, entropy(Uint8Array.from([2, 0, 1, 2, 3, 0, 0, 1]), 0)]), CodecError, 'range'); // k=1 인데 인덱스 1
  rejects(assemble(3, 2, [...e, entropy(Uint8Array.from([2, 0, 1, 2, 3, 0, 0]), 0)]), CodecError, 'limit'); // 7 B < 색 스트림 하한 min(n+5, 3n+1)=8
  rejects(assemble(3, 2, [...e, entropy(Uint8Array.from([2, 2, 0, 1, 2, 3, 0, 0, 1]), 0)]), CodecError, 'stream'); // 하한 이상이나 k=3 이면 14 B 여야 한다
});
test('거부: 모르는 codec·짧은 입력은 AssetFormatError', () => {
  const f = small(); f[OFFSETS.codec] = 9;
  rejects(f, AssetFormatError, 'codec');
  rejects(new Uint8Array(5), AssetFormatError, 'short');
  rejects(small().subarray(0, 200), AssetFormatError);
  const g = small(); g[0] = 0;
  rejects(g, AssetFormatError, 'magic');
});

// ---------- ④ 무작위 손상 5천 회 ----------
test('무작위 손상 5000 회: CodecError 또는 AssetFormatError 만', () => {
  const R = rng(777);
  const ri = (m) => Math.floor(R() * m);
  const bases = [
    encodeFile(randomPoints(60, 1), { colorMode: 0, ent: 1 }).file,
    encodeFile(randomPoints(60, 2), { colorMode: 1, ent: 1 }).file,
    encodeFile(randomPoints(60, 3, { palette: 9 }), { colorMode: 2, ent: 0 }).file,
    fileOf(6, GOLD_BODY),
  ];
  let okCount = 0, codecErr = 0, assetErr = 0;
  for (let t = 0; t < 5000; t++) {
    let f = bases[ri(bases.length)].slice();
    const kind = ri(6);
    if (kind === 0) f[ri(f.length)] ^= 1 << ri(8);
    else if (kind === 1) { for (let k = 0; k < 1 + ri(4); k++) f[128 + ri(f.length - 128)] = ri(256); }
    else if (kind === 2) f = f.slice(0, ri(f.length));
    else if (kind === 3) f = Uint8Array.from([...f, ...Array.from({ length: 1 + ri(8) }, () => ri(256))]);
    else if (kind === 4) { f[128 + ri(16)] = ri(256); }
    else { for (let k = 0; k < 3; k++) f[ri(f.length)] = ri(256); }
    // 절반은 체크섬을 다시 맞춰 내부 복호기까지 도달시킨다(길이가 맞는 경우만)
    if (f.length >= 128 && ri(2) === 0) {
      const dv = new DataView(f.buffer);
      if (f.length - 128 === dv.getUint32(OFFSETS.bodyBytes, true)) refresh(f);
    }
    try {
      const r = decodeChunkClient(f);
      okCount++;
      assert.equal(r.planes.pos_e.length, r.header.pointCount);
    } catch (e) {
      if (e instanceof CodecError) codecErr++;
      else if (e instanceof AssetFormatError) assetErr++;
      else assert.fail(`다른 예외: ${e && e.stack}`);
    }
  }
  // 항상 참(상호배타적 결과): okCount + codecErr + assetErr === 5000 는 삭제.
  // 의미있는 단언: 손상 입력이 충분히 거부되는지(거부 비율 > 80%)
  assert.ok(codecErr + assetErr > 4000, `거부 수 ${codecErr + assetErr} (목표 > 4000)`);
  assert.ok(codecErr > 400, `CodecError 경로 ${codecErr} (목표 > 400)`);
  assert.ok(assetErr > 400, `AssetFormatError 경로 ${assetErr} (목표 > 400)`);
});
