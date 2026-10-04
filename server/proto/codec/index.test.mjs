// server/proto/codec 시험: 손으로 계산한 바이트 기대값, 왕복, 오류 코드, 경계값.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, decodeMessage } from './index.mjs';
import { ProtoError, MAX_PAYLOAD_BYTES } from '../../../contracts/proto/index.mjs';

const H = (type, plen) => [type, 1, 0, 0, plen & 255, (plen >> 8) & 255, (plen >> 16) & 255, (plen >>> 24) & 255];
const hex = (b) => Array.from(b);
function code(fn) {
  try { fn(); } catch (e) { assert.ok(e instanceof ProtoError, String(e)); return e.code; }
  return null;
}
const KEY = { segmentId: 0x01020304, level: 2, lod: 7, chunkIndex: 0x0506, tileX: -1, tileY: 0x7fffffff };
const KEY_BYTES = [4, 3, 2, 1, 2, 7, 6, 5, 255, 255, 255, 255, 255, 255, 255, 127];
const frameOf = (type, body, over = {}) => {
  const b = Uint8Array.from([...H(type, body.length), ...body]);
  for (const [i, v] of Object.entries(over)) b[i] = v;
  return b;
};
const ack = (n) => frameOf(4, [n & 255, (n >> 8) & 255, 0, 0]);

test('ACK 바이트 고정: upTo=0x01020304', () => {
  const e = encodeMessage({ type: 'ACK', upToPieceSeq: 0x01020304 });
  assert.deepEqual(hex(e), [4, 1, 0, 0, 4, 0, 0, 0, 4, 3, 2, 1]);
  assert.deepEqual(decodeMessage(e), { type: 'ACK', upToPieceSeq: 0x01020304 });
});

test('HELLO 바이트 고정과 왕복', () => {
  const m = { type: 'HELLO', sessionId: 0xaabbccdd, lastPieceSeq: 5 };
  const e = encodeMessage(m);
  assert.deepEqual(hex(e), [1, 1, 0, 0, 9, 0, 0, 0, 0xdd, 0xcc, 0xbb, 0xaa, 5, 0, 0, 0, 0]);
  assert.deepEqual(decodeMessage(e), m);
});

test('VIEW_UPDATE 바이트 고정과 왕복', () => {
  const m = { type: 'VIEW_UPDATE', viewSeq: 1, pos: [1, -2, 0.5], quat: [0, 0, 0, 1], fovY: 1, width: 0x0102, height: 3 };
  const e = encodeMessage(m);
  // f32: 1.0=00 00 80 3f, -2.0=00 00 00 c0, 0.5=00 00 00 3f, 0=0000 0000
  assert.deepEqual(hex(e), [
    2, 1, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0,
    0, 0, 0x80, 0x3f, 0, 0, 0, 0xc0, 0, 0, 0, 0x3f,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80, 0x3f,
    0, 0, 0x80, 0x3f, 2, 1, 3, 0]);
  assert.deepEqual(decodeMessage(e), m);
});

test('PIECE_REQUEST 바이트 고정과 왕복(0개·2개)', () => {
  const m = { type: 'PIECE_REQUEST', reqId: 9, items: [KEY, KEY] };
  const e = encodeMessage(m);
  assert.deepEqual(hex(e), [3, 1, 0, 0, 38, 0, 0, 0, 9, 0, 0, 0, 2, 0, ...KEY_BYTES, ...KEY_BYTES]);
  assert.deepEqual(decodeMessage(e), m);
  const z = { type: 'PIECE_REQUEST', reqId: 0, items: [] };
  assert.deepEqual(hex(encodeMessage(z)), [3, 1, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(decodeMessage(encodeMessage(z)), z);
});

test('s2c 종류 부호화 바이트 고정', () => {
  assert.deepEqual(hex(encodeMessage({ type: 'WELCOME', sessionId: 1, resumed: true, nextPieceSeq: 0x0a0b0c0d })),
    [5, 1, 0, 0, 9, 0, 0, 0, 1, 0, 0, 0, 1, 0x0d, 0x0c, 0x0b, 0x0a]);
  assert.deepEqual(hex(encodeMessage({ type: 'PIECE', pieceSeq: 2, key: KEY, chunk: Uint8Array.of(0xaa, 0xbb) })),
    [6, 1, 0, 0, 22, 0, 0, 0, 2, 0, 0, 0, ...KEY_BYTES, 0xaa, 0xbb]);
  assert.deepEqual(hex(encodeMessage({ type: 'LEVEL_ARRIVED', segmentId: 7, level: 3, pieceCount: 258 })),
    [7, 1, 0, 0, 9, 0, 0, 0, 7, 0, 0, 0, 3, 2, 1, 0, 0]);
  assert.deepEqual(hex(encodeMessage({ type: 'MISSING', segmentId: 0x3fffffff })), [8, 1, 0, 0, 4, 0, 0, 0, 255, 255, 255, 0x3f]);
  assert.deepEqual(hex(encodeMessage({ type: 'ERROR', code: 4, text: '한' })),
    [9, 1, 0, 0, 7, 0, 0, 0, 4, 0, 3, 0, 0xed, 0x95, 0x9c]);
});

test('서버 복호는 s2c 종류를 direction 으로 거부', () => {
  for (const m of [
    { type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq: 1 },
    { type: 'PIECE', pieceSeq: 1, key: KEY, chunk: Uint8Array.of(1) },
    { type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 0 },
    { type: 'MISSING', segmentId: 0 },
    { type: 'ERROR', code: 1, text: '' },
  ]) assert.equal(code(() => decodeMessage(encodeMessage(m))), 'direction', m.type);
});

test('s2c 부호화 왕복 값(복호는 클라이언트 몫이므로 본문 바이트로 확인)', () => {
  const e = encodeMessage({ type: 'PIECE', pieceSeq: 1, key: KEY, chunk: new Uint8Array(1000).fill(7) });
  assert.equal(e.length, 8 + 20 + 1000);
});

test('오류 short', () => {
  assert.equal(code(() => decodeMessage(new Uint8Array(0))), 'short');
  assert.equal(code(() => decodeMessage(ack(1).subarray(0, 7))), 'short');
});
test('오류 type', () => {
  assert.equal(code(() => decodeMessage(ack(1).map((v, i) => (i === 0 ? 0 : v)))), 'type');
  assert.equal(code(() => decodeMessage(ack(1).map((v, i) => (i === 0 ? 10 : v)))), 'type');
  assert.equal(code(() => encodeMessage({ type: 'NOPE' })), 'type');
});
test('오류 version', () => {
  assert.equal(code(() => decodeMessage(ack(1).map((v, i) => (i === 1 ? 2 : v)))), 'version');
});
test('오류 reserved', () => {
  assert.equal(code(() => decodeMessage(ack(1).map((v, i) => (i === 2 ? 1 : v)))), 'reserved');
  assert.equal(code(() => decodeMessage(ack(1).map((v, i) => (i === 3 ? 1 : v)))), 'reserved');
});
test('오류 limit 와 경계', () => {
  const h = (plen) => Uint8Array.from(H(4, plen));
  assert.equal(code(() => decodeMessage(h(MAX_PAYLOAD_BYTES + 1))), 'limit');
  assert.equal(code(() => decodeMessage(h(0xffffffff))), 'limit');
  // 상한과 같으면 limit 아님(프레임 길이 불일치로 length)
  assert.equal(code(() => decodeMessage(h(MAX_PAYLOAD_BYTES))), 'length');
  // 부호화: 상한 정확히는 가능, 1 초과는 limit
  const ok = encodeMessage({ type: 'PIECE', pieceSeq: 1, key: KEY, chunk: new Uint8Array(MAX_PAYLOAD_BYTES - 20) });
  assert.equal(ok.length, 8 + MAX_PAYLOAD_BYTES);
  assert.equal(code(() => encodeMessage({ type: 'PIECE', pieceSeq: 1, key: KEY, chunk: new Uint8Array(MAX_PAYLOAD_BYTES - 19) })), 'limit');
});
test('오류 length', () => {
  assert.equal(code(() => decodeMessage(Uint8Array.from([...ack(1), 0]))), 'length'); // 프레임이 더 김
  assert.equal(code(() => decodeMessage(ack(1).subarray(0, 11))), 'length'); // 더 짧음
  assert.equal(code(() => decodeMessage(frameOf(4, [1, 2, 3, 4, 5]))), 'length'); // 고정 크기 불일치
  assert.equal(code(() => decodeMessage(frameOf(1, new Array(8).fill(0)))), 'length');
  assert.equal(code(() => decodeMessage(frameOf(2, new Array(39).fill(0)))), 'length');
  assert.equal(code(() => decodeMessage(frameOf(3, [0, 0, 0, 0, 1, 0]))), 'length'); // count 1 인데 항목 없음
  assert.equal(code(() => decodeMessage(frameOf(3, [0, 0, 0]))), 'length');
});
test('오류 field: 복호', () => {
  assert.equal(code(() => decodeMessage(frameOf(1, [0, 0, 0, 0, 0, 0, 0, 0, 1]))), 'field'); // flags
  const view = (mut) => {
    const m = { type: 'VIEW_UPDATE', viewSeq: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: 1, width: 1, height: 1 };
    return decodeMessage(encodeMessageRaw(m, mut));
  };
  assert.equal(code(() => view((b) => b.setFloat32(8 + 4, NaN, true))), 'field'); // pos NaN
  assert.equal(code(() => view((b) => b.setFloat32(8 + 8, Infinity, true))), 'field');
  assert.equal(code(() => view((b) => b.setFloat32(8 + 28, 2, true))), 'field'); // quat 노름 2
  assert.equal(code(() => view((b) => b.setFloat32(8 + 32, 0, true))), 'field'); // fovY 0
  assert.equal(code(() => view((b) => b.setFloat32(8 + 32, Math.PI, true))), 'field');
  assert.equal(code(() => view((b) => b.setUint16(8 + 36, 0, true))), 'field'); // width 0
  assert.equal(code(() => view((b) => b.setUint16(8 + 38, 0, true))), 'field');
  const req = (key) => decodeMessage(encodeMessage({ type: 'PIECE_REQUEST', reqId: 0, items: [{ ...KEY, ...key }] }));
  assert.equal(code(() => req({ level: 4 })), 'field'); // 부호화가 이미 field
  const raw = (mut) => {
    const b = encodeMessage({ type: 'PIECE_REQUEST', reqId: 0, items: [KEY] });
    mut(new DataView(b.buffer));
    return decodeMessage(b);
  };
  assert.equal(code(() => raw((d) => d.setUint8(8 + 6 + 4, 4))), 'field'); // level 4
  assert.equal(code(() => raw((d) => d.setUint8(8 + 6 + 5, 8))), 'field'); // lod 8
  assert.equal(code(() => raw((d) => d.setUint32(8 + 6, 2 ** 30, true))), 'field'); // segmentId 한계
});
function encodeMessageRaw(m, mut) {
  const b = encodeMessage(m);
  mut(new DataView(b.buffer));
  return b;
}
test('경계값: 통과', () => {
  const okView = { type: 'VIEW_UPDATE', viewSeq: 0xffffffff, pos: [1e30, -1e30, 0], quat: [0, 0, 0, 1.0009], fovY: 3.14, width: 65535, height: 1 };
  const d = decodeMessage(encodeMessage(okView));
  assert.equal(d.width, 65535); assert.equal(d.viewSeq, 0xffffffff);
  const key = { segmentId: 2 ** 30 - 1, level: 3, lod: 7, chunkIndex: 65535, tileX: -2147483648, tileY: 2147483647 };
  assert.deepEqual(decodeMessage(encodeMessage({ type: 'PIECE_REQUEST', reqId: 0xffffffff, items: [key] })).items[0], key);
  assert.deepEqual(decodeMessage(encodeMessage({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0xffffffff })).lastPieceSeq, 0xffffffff);
});
test('PIECE_REQUEST 256 항목 통과, 257 항목 거부(부호화·복호)', () => {
  const items = (n) => Array.from({ length: n }, (_, i) => ({ ...KEY, chunkIndex: i }));
  const e = encodeMessage({ type: 'PIECE_REQUEST', reqId: 1, items: items(256) });
  assert.equal(e.length, 8 + 6 + 16 * 256);
  assert.equal(decodeMessage(e).items.length, 256);
  assert.equal(code(() => encodeMessage({ type: 'PIECE_REQUEST', reqId: 1, items: items(257) })), 'field');
  const raw = new Uint8Array(8 + 6 + 16 * 257);
  raw.set(H(3, 6 + 16 * 257));
  new DataView(raw.buffer).setUint16(8 + 4, 257, true);
  for (let i = 0; i < 257; i++) raw.set(KEY_BYTES, 14 + 16 * i);
  assert.equal(code(() => decodeMessage(raw)), 'field');
});
test('부호화 field 오류', () => {
  assert.equal(code(() => encodeMessage({ type: 'ACK', upToPieceSeq: 2 ** 32 })), 'field');
  assert.equal(code(() => encodeMessage({ type: 'ACK', upToPieceSeq: -1 })), 'field');
  assert.equal(code(() => encodeMessage({ type: 'ACK', upToPieceSeq: 1.5 })), 'field');
  assert.equal(code(() => encodeMessage({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 4, pieceCount: 0 })), 'field');
  assert.equal(code(() => encodeMessage({ type: 'MISSING', segmentId: 2 ** 30 })), 'field');
  assert.equal(code(() => encodeMessage({ type: 'WELCOME', sessionId: 0, resumed: 1, nextPieceSeq: 1 })), 'field');
  assert.equal(code(() => encodeMessage({ type: 'PIECE', pieceSeq: 1, key: KEY, chunk: new Uint8Array(0) })), 'field');
  assert.equal(code(() => encodeMessage({ type: 'ERROR', code: 1, text: 'a'.repeat(257) })), 'field');
  assert.equal(encodeMessage({ type: 'ERROR', code: 1, text: 'a'.repeat(256) }).length, 8 + 4 + 256);
  assert.equal(code(() => encodeMessage({ type: 'ERROR', code: 99, text: '' })), 'field');
  const v = { type: 'VIEW_UPDATE', viewSeq: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: 1, width: 1, height: 1 };
  assert.equal(code(() => encodeMessage({ ...v, quat: [0, 0, 0, 1.01] })), 'field');
  assert.equal(code(() => encodeMessage({ ...v, fovY: Math.PI })), 'field');
  assert.equal(code(() => encodeMessage({ ...v, pos: [0, NaN, 0] })), 'field');
  assert.equal(code(() => encodeMessage({ ...v, width: 0 })), 'field');
  assert.equal(code(() => encodeMessage({ ...v, height: 65536 })), 'field');
});

test('chunkIndex 65535 왕복 성공, 65536 거부', () => {
  const key65535 = { segmentId: 1, level: 0, lod: 0, chunkIndex: 65535, tileX: 0, tileY: 0 };
  const key65536 = { segmentId: 1, level: 0, lod: 0, chunkIndex: 65536, tileX: 0, tileY: 0 };
  // 65535는 성공
  const msg65535 = { type: 'PIECE_REQUEST', reqId: 0, items: [key65535] };
  assert.deepEqual(decodeMessage(encodeMessage(msg65535)).items[0], key65535);
  // 65536은 실패
  assert.equal(code(() => encodeMessage({ type: 'PIECE_REQUEST', reqId: 0, items: [key65536] })), 'field');
});

test('서버 복호 바이트배열 아님은 short', () => {
  assert.equal(code(() => decodeMessage(null)), 'short');
  assert.equal(code(() => decodeMessage('string')), 'short');
  assert.equal(code(() => decodeMessage(123)), 'short');
  assert.equal(code(() => decodeMessage(Buffer.from([1, 2, 3]))), 'short');
});

test('pieceSeq·nextPieceSeq 0 은 field, 1 은 왕복(부호화)', () => {
  assert.equal(code(() => encodeMessage({ type: 'PIECE', pieceSeq: 0, key: KEY, chunk: Uint8Array.of(1) })), 'field');
  assert.equal(code(() => encodeMessage({ type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq: 0 })), 'field');
  assert.deepEqual(hex(encodeMessage({ type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq: 1 })).slice(13), [1, 0, 0, 0]);
  assert.deepEqual(hex(encodeMessage({ type: 'PIECE', pieceSeq: 1, key: KEY, chunk: Uint8Array.of(1) })).slice(8, 12), [1, 0, 0, 0]);
  assert.equal(code(() => encodeMessage({ type: 'PIECE', pieceSeq: 0xffffffff, key: KEY, chunk: Uint8Array.of(1) })), null);
  assert.equal(code(() => encodeMessage({ type: 'PIECE', pieceSeq: 2 ** 32, key: KEY, chunk: Uint8Array.of(1) })), 'field');
});
test('서버 복호: pieceSeq 0 프레임은 s2c 라 direction(1 도 동일)', () => {
  const w = (seq) => { const e = encodeMessage({ type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq: 1 }); new DataView(e.buffer).setUint32(13, seq, true); return e; };
  assert.equal(code(() => decodeMessage(w(0))), 'direction');
  assert.equal(code(() => decodeMessage(w(1))), 'direction');
});
