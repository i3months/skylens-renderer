// client/proto 시험: 손으로 계산한 바이트 기대값, 전 오류 코드, 왕복.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, decodeMessage } from './index.mjs';
import { ProtoError, MAX_PAYLOAD_BYTES, MAX_REQUEST_ITEMS, MAX_ERROR_TEXT } from '../../contracts/proto/index.mjs';

const hex = (s) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16)));
const toHex = (u) => Buffer.from(u).toString('hex');
const code = (fn) => { try { fn(); } catch (e) { if (e instanceof ProtoError) return e.code; throw e; } return 'ok'; };

// 손으로 계산한 프레임(머리 8 B = type, version 01, reserved 0000, payloadLength u32 LE).
const CASES = [
  ['HELLO', { type: 'HELLO', sessionId: 0x12345678, lastPieceSeq: 2 }, '01 01 0000 09000000 78563412 02000000 00'],
  ['VIEW_UPDATE', { type: 'VIEW_UPDATE', viewSeq: 1, pos: [1, -2, 0.5], quat: [0, 0, 0, 1], fovY: 1, width: 1920, height: 1080 },
    '02 01 0000 28000000 01000000 0000803f 000000c0 0000003f 00000000 00000000 00000000 0000803f 0000803f 8007 3804'],
  ['PIECE_REQUEST', { type: 'PIECE_REQUEST', reqId: 9, items: [{ segmentId: 2, level: 0, lod: 1, chunkIndex: 3, tileX: 4, tileY: -5 }] },
    '03 01 0000 16000000 09000000 0100 02000000 00 01 0300 04000000 fbffffff'],
  ['ACK', { type: 'ACK', upToPieceSeq: 0xffffffff }, '04 01 0000 04000000 ffffffff'],
  ['WELCOME', { type: 'WELCOME', sessionId: 1, resumed: true, nextPieceSeq: 0x100 }, '05 01 0000 09000000 01000000 01 00010000'],
  ['PIECE', { type: 'PIECE', pieceSeq: 3, key: { segmentId: 1, level: 2, lod: 3, chunkIndex: 0x0405, tileX: -1, tileY: 16 }, chunk: Uint8Array.of(0xaa, 0xbb) },
    '06 01 0000 16000000 03000000 01000000 02 03 0504 ffffffff 10000000 aabb'],
  ['LEVEL_ARRIVED', { type: 'LEVEL_ARRIVED', segmentId: 5, level: 2, pieceCount: 7 }, '07 01 0000 09000000 05000000 02 07000000'],
  ['MISSING', { type: 'MISSING', segmentId: 0x01020304 }, '08 01 0000 04000000 04030201'],
  ['ERROR', { type: 'ERROR', code: 4, text: '초' }, '09 01 0000 07000000 0400 0300 ecb488'],
];
const S2C = ['WELCOME', 'PIECE', 'LEVEL_ARRIVED', 'MISSING', 'ERROR'];

for (const [name, msg, h] of CASES) {
  test(`부호화 바이트 ${name}`, () => assert.equal(toHex(encodeMessage(msg)), toHex(hex(h))));
  test(`복호 ${name}`, () => {
    if (S2C.includes(name)) assert.deepEqual(decodeMessage(hex(h)), msg);
    else assert.equal(code(() => decodeMessage(hex(h))), 'direction');
  });
}

test('PIECE 복호 결과는 입력 버퍼와 메모리를 공유하지 않는다', () => {
  const f = hex('06 01 0000 16000000 03000000 01000000 02 03 0504 ffffffff 10000000 aabb');
  const m = decodeMessage(f);
  f[f.length - 1] = 0;
  assert.equal(m.chunk[1], 0xbb);
});

test('오류 short', () => {
  assert.equal(code(() => decodeMessage(new Uint8Array(0))), 'short');
  assert.equal(code(() => decodeMessage(hex('08 01 0000 0400 00'))), 'short');
});
test('오류 type', () => {
  assert.equal(code(() => decodeMessage(hex('00 01 0000 00000000'))), 'type');
  assert.equal(code(() => decodeMessage(hex('0a 01 0000 00000000'))), 'type');
  assert.equal(code(() => encodeMessage({ type: 'NOPE' })), 'type');
});
test('오류 direction', () => {
  assert.equal(code(() => decodeMessage(hex('04 01 0000 04000000 00000000'))), 'direction');
  // 방향 검사는 프레임 length 검사 다음, 고정 크기 검사 앞이다.
  assert.equal(code(() => decodeMessage(hex('04 01 0000 03000000 000000'))), 'direction'); // 고정 크기 불일치여도 direction
  assert.equal(code(() => decodeMessage(hex('04 01 0000 04000000 000000'))), 'length'); // 프레임 길이 불일치가 먼저
  assert.equal(code(() => decodeMessage(hex('04 02 0000 04000000 00000000'))), 'version'); // version 이 먼저
  assert.equal(code(() => decodeMessage(hex('04 01 0100 04000000 00000000'))), 'reserved');
  const h = hex('04 01 0000 00000000'); new DataView(h.buffer).setUint32(4, MAX_PAYLOAD_BYTES + 1, true);
  assert.equal(code(() => decodeMessage(h)), 'limit');
});
test('오류 version', () => assert.equal(code(() => decodeMessage(hex('08 02 0000 04000000 00000000'))), 'version'));
test('오류 reserved', () => {
  assert.equal(code(() => decodeMessage(hex('08 01 0100 04000000 00000000'))), 'reserved');
  // reserved 는 limit·length 보다 앞
  assert.equal(code(() => decodeMessage(hex('08 01 0001 ffffffff'))), 'reserved');
});
test('오류 limit', () => {
  const over = MAX_PAYLOAD_BYTES + 1;
  const h = new Uint8Array(8); h.set([8, 1, 0, 0]); new DataView(h.buffer).setUint32(4, over, true);
  assert.equal(code(() => decodeMessage(h)), 'limit'); // 프레임이 짧아도 limit 가 length 보다 앞
  assert.equal(code(() => encodeMessage({ type: 'PIECE', pieceSeq: 1, key: CASES[5][1].key, chunk: new Uint8Array(MAX_PAYLOAD_BYTES) })), 'limit');
  // 상한 딱 맞는 본문은 통과
  const ok = encodeMessage({ type: 'PIECE', pieceSeq: 1, key: CASES[5][1].key, chunk: new Uint8Array(MAX_PAYLOAD_BYTES - 20) });
  assert.equal(ok.length, 8 + MAX_PAYLOAD_BYTES);
  assert.equal(decodeMessage(ok).chunk.length, MAX_PAYLOAD_BYTES - 20);
});
test('오류 length', () => {
  assert.equal(code(() => decodeMessage(hex('08 01 0000 04000000 040302'))), 'length'); // 짧음
  assert.equal(code(() => decodeMessage(hex('08 01 0000 04000000 0403020100'))), 'length'); // 김
  assert.equal(code(() => decodeMessage(hex('08 01 0000 03000000 040302'))), 'length'); // 고정 크기 불일치
  assert.equal(code(() => decodeMessage(hex('05 01 0000 08000000 0100000001000000'))), 'length');
  assert.equal(code(() => decodeMessage(hex('06 01 0000 14000000 03000000 01000000 02 03 0504 ffffffff 10000000'))), 'length'); // 조각 0 B
  assert.equal(code(() => decodeMessage(hex('09 01 0000 03000000 040000'))), 'length'); // ERROR 본문 < 4
  assert.equal(code(() => decodeMessage(hex('09 01 0000 06000000 0400 0300 ecb4'))), 'length'); // msgLen 불일치
  // length 는 field 보다 앞: resumed=9 이지만 길이도 틀리면 length
  assert.equal(code(() => decodeMessage(hex('05 01 0000 0a000000 01000000 09 00010000 00'))), 'length');
});
test('오류 field(복호)', () => {
  assert.equal(code(() => decodeMessage(hex('05 01 0000 09000000 01000000 02 00010000'))), 'field'); // resumed 2
  assert.equal(code(() => decodeMessage(hex('07 01 0000 09000000 05000000 04 07000000'))), 'field'); // level 4
  assert.equal(code(() => decodeMessage(hex('07 01 0000 09000000 000000c0 00 00000000'))), 'field'); // segmentId >= 2^30
  assert.equal(code(() => decodeMessage(hex('08 01 0000 04000000 00000040'))), 'field');
  assert.equal(code(() => decodeMessage(hex('06 01 0000 15000000 03000000 01000000 04 03 0504 ffffffff 10000000 aa'))), 'field'); // key.level 4
  assert.equal(code(() => decodeMessage(hex('06 01 0000 15000000 03000000 01000000 02 08 0504 ffffffff 10000000 aa'))), 'field'); // lod 8
  assert.equal(code(() => decodeMessage(hex('09 01 0000 04000000 0000 0000'))), 'field'); // code 0
  assert.equal(code(() => decodeMessage(hex('09 01 0000 04000000 0600 0000'))), 'field'); // code 6
  assert.equal(code(() => decodeMessage(hex('09 01 0000 05000000 0100 0100 ff'))), 'field'); // utf8 아님
  const big = new Uint8Array(8 + 4 + MAX_ERROR_TEXT + 1).fill(0x61);
  big.set(hex('09 01 0000'), 0); new DataView(big.buffer).setUint32(4, 4 + MAX_ERROR_TEXT + 1, true);
  new DataView(big.buffer).setUint16(8, 1, true); new DataView(big.buffer).setUint16(10, MAX_ERROR_TEXT + 1, true);
  assert.equal(code(() => decodeMessage(big)), 'field'); // msgLen > 256
});
test('오류 field(부호화)', () => {
  const v = CASES[1][1];
  const bad = [
    { type: 'HELLO', sessionId: -1, lastPieceSeq: 0 }, { type: 'HELLO', sessionId: 2 ** 32, lastPieceSeq: 0 },
    { type: 'HELLO', sessionId: 1.5, lastPieceSeq: 0 }, { type: 'HELLO', sessionId: 0 },
    { ...v, fovY: 0 }, { ...v, fovY: Math.PI }, { ...v, fovY: NaN }, { ...v, fovY: Infinity },
    { ...v, quat: [0, 0, 0, 1.01] }, { ...v, quat: [0, 0, 0] }, { ...v, quat: [NaN, 0, 0, 1] }, { ...v, pos: [Infinity, 0, 0] },
    { ...v, pos: [1e300, 0, 0] }, { ...v, width: 0 }, { ...v, height: 65536 }, { ...v, width: 1.5 },
    { type: 'PIECE_REQUEST', reqId: 0, items: Array.from({ length: MAX_REQUEST_ITEMS + 1 }, (_, i) => ({ segmentId: 0, level: 0, lod: 0, chunkIndex: i, tileX: 0, tileY: 0 })) },
    { type: 'PIECE_REQUEST', reqId: 0, items: [{ ...CASES[2][1].items[0], tileX: 2 ** 31 }] },
    { type: 'PIECE_REQUEST', reqId: 0, items: [{ ...CASES[2][1].items[0], chunkIndex: 65536 }] },
    { type: 'WELCOME', sessionId: 0, resumed: 1, nextPieceSeq: 1 },
    { ...CASES[5][1], chunk: new Uint8Array(0) }, { ...CASES[5][1], chunk: [1] }, { ...CASES[5][1], key: { ...CASES[5][1].key, level: 4 } },
    { type: 'LEVEL_ARRIVED', segmentId: 0, level: 4, pieceCount: 0 }, { type: 'MISSING', segmentId: 2 ** 30 },
    { type: 'ERROR', code: 99, text: '' }, { type: 'ERROR', code: 1, text: 'a'.repeat(MAX_ERROR_TEXT + 1) }, { type: 'ERROR', code: 1, text: 5 },
  ];
  bad.forEach((m, i) => assert.equal(code(() => encodeMessage(m)), 'field', `사례 ${i}`));
  // 같은 키 중복은 계약에 없어 부호화가 통과한다
  assert.equal(encodeMessage({ type: 'PIECE_REQUEST', reqId: 0, items: [CASES[2][1].items[0], CASES[2][1].items[0]] }).length, 8 + 6 + 32);
  // 경계값은 통과
  encodeMessage({ ...v, quat: [0, 0, 0, 1.0005] });
  encodeMessage({ type: 'ERROR', code: 1, text: 'a'.repeat(MAX_ERROR_TEXT) });
  encodeMessage({ type: 'MISSING', segmentId: 2 ** 30 - 1 });
});

test('s2c 왕복 / 전 종류 부호화 후 같은 값', () => {
  for (const [name, msg] of CASES) if (S2C.includes(name)) assert.deepEqual(decodeMessage(encodeMessage(msg)), msg);
  const e = { type: 'ERROR', code: 5, text: '' };
  assert.deepEqual(decodeMessage(encodeMessage(e)), e);
});

test('chunkIndex 65535 부호화 성공, 65536 거부', () => {
  const key65535 = { segmentId: 1, level: 0, lod: 0, chunkIndex: 65535, tileX: 0, tileY: 0 };
  const key65536 = { segmentId: 1, level: 0, lod: 0, chunkIndex: 65536, tileX: 0, tileY: 0 };
  // 65535는 성공
  const msg65535 = { type: 'PIECE_REQUEST', reqId: 0, items: [key65535] };
  assert.equal(encodeMessage(msg65535).length > 0, true);
  // 65536은 실패
  assert.equal(code(() => encodeMessage({ type: 'PIECE_REQUEST', reqId: 0, items: [key65536] })), 'field');
  // PIECE 도 테스트
  const piece65535 = { type: 'PIECE', pieceSeq: 1, key: key65535, chunk: new Uint8Array([1]) };
  assert.equal(encodeMessage(piece65535).length > 0, true);
  const piece65536 = { type: 'PIECE', pieceSeq: 1, key: key65536, chunk: new Uint8Array([1]) };
  assert.equal(code(() => encodeMessage(piece65536)), 'field');
});

test('BOM 텍스트 왕복 동일', () => {
  const bom = '﻿';
  const textWithBom = bom + '테스트';
  const textWithoutBom = '테스트';
  // BOM 있는 텍스트와 없는 텍스트를 인코딩하고 디코딩
  const encoded1 = encodeMessage({ type: 'ERROR', code: 1, text: textWithBom });
  const encoded2 = encodeMessage({ type: 'ERROR', code: 1, text: textWithoutBom });
  // ignoreBOM: true 이므로 두 경우 모두 같게 디코딩되어야 함
  const decoded1 = decodeMessage(encoded1);
  const decoded2 = decodeMessage(encoded2);
  // 인코딩된 바이트는 다를 수 있지만, ignoreBOM: true 이므로 디코딩시 같아야 함
  assert.equal(decoded1.text, textWithBom);
  assert.equal(decoded2.text, textWithoutBom);
});

test('배열 흉내 객체 거부', () => {
  const arrayLike = { 0: 1, 1: -2, 2: 0.5, length: 3 };
  assert.equal(code(() => encodeMessage({ type: 'VIEW_UPDATE', viewSeq: 0, pos: arrayLike, quat: [0, 0, 0, 1], fovY: 1, width: 1, height: 1 })), 'field');
  assert.equal(code(() => encodeMessage({ type: 'VIEW_UPDATE', viewSeq: 0, pos: [1, -2, 0.5], quat: arrayLike, fovY: 1, width: 1, height: 1 })), 'field');
});

test('pieceSeq·nextPieceSeq 0 은 field, 1 은 왕복(부호화·복호)', () => {
  const piece = (pieceSeq) => ({ ...CASES[5][1], pieceSeq });
  const welcome = (nextPieceSeq) => ({ type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq });
  assert.equal(code(() => encodeMessage(piece(0))), 'field');
  assert.equal(code(() => encodeMessage(welcome(0))), 'field');
  assert.deepEqual(decodeMessage(encodeMessage(piece(1))), piece(1));
  assert.deepEqual(decodeMessage(encodeMessage(welcome(1))), welcome(1));
  // 복호: 1 로 부호화한 프레임의 seq 바이트만 0 으로 바꾼다
  const pf = encodeMessage(piece(1)); new DataView(pf.buffer).setUint32(8, 0, true);
  const wf = encodeMessage(welcome(1)); new DataView(wf.buffer).setUint32(13, 0, true);
  assert.equal(code(() => decodeMessage(pf)), 'field');
  assert.equal(code(() => decodeMessage(wf)), 'field');
});

test('LEVEL_ARRIVED pieceCount 0 은 부호화·복호 모두 field, 1 은 왕복(계약 >= 1)', () => {
  const m = (pieceCount) => ({ type: 'LEVEL_ARRIVED', segmentId: 5, level: 2, pieceCount });
  assert.equal(code(() => encodeMessage(m(0))), 'field');
  assert.equal(code(() => decodeMessage(hex('07 01 0000 09000000 05000000 02 00000000'))), 'field');
  assert.deepEqual(decodeMessage(encodeMessage(m(1))), m(1));
  assert.deepEqual(decodeMessage(hex('07 01 0000 09000000 05000000 02 ffffffff')), m(0xffffffff));
});
