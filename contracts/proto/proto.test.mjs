import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from './index.mjs';

test('메시지 종류 9개, 방향·고정 크기 표가 빠짐없다', () => {
  assert.equal(Object.keys(P.MSG).length, 9);
  for (const v of Object.values(P.MSG)) assert.ok(P.DIRECTION[v]);
  assert.deepEqual(Object.keys(P.FIXED_PAYLOAD_BYTES).map(Number).sort(), [1, 2, 4, 5, 7, 8]);
  assert.equal(P.FIXED_PAYLOAD_BYTES[P.MSG.VIEW_UPDATE], 4 + 12 + 16 + 4 + 2 + 2);
});

// ---- 계약 값 리터럴 고정: 상수·표가 슬며시 바뀌면 서버·클라이언트가 같이 틀리므로 여기서 리터럴로 못 박는다 ----
test('MSG 리터럴', () => {
  assert.deepEqual({ ...P.MSG }, { HELLO: 1, VIEW_UPDATE: 2, PIECE_REQUEST: 3, ACK: 4, WELCOME: 5, PIECE: 6, LEVEL_ARRIVED: 7, MISSING: 8, ERROR: 9 });
  assert.ok(Object.isFrozen(P.MSG));
  assert.deepEqual({ ...P.MSG_NAMES }, { 1: 'HELLO', 2: 'VIEW_UPDATE', 3: 'PIECE_REQUEST', 4: 'ACK', 5: 'WELCOME', 6: 'PIECE', 7: 'LEVEL_ARRIVED', 8: 'MISSING', 9: 'ERROR' });
});
test('DIRECTION 리터럴(ACK 는 c2s, WELCOME·PIECE·LEVEL_ARRIVED·MISSING·ERROR 는 s2c)', () => {
  assert.deepEqual({ ...P.DIRECTION }, { 1: 'c2s', 2: 'c2s', 3: 'c2s', 4: 'c2s', 5: 's2c', 6: 's2c', 7: 's2c', 8: 's2c', 9: 's2c' });
  assert.ok(Object.isFrozen(P.DIRECTION));
});
test('FIXED_PAYLOAD_BYTES 리터럴', () => {
  assert.deepEqual({ ...P.FIXED_PAYLOAD_BYTES }, { 1: 9, 2: 40, 4: 4, 5: 9, 7: 9, 8: 4 });
  assert.ok(Object.isFrozen(P.FIXED_PAYLOAD_BYTES));
});
test('ERR_CODES 리터럴', () => {
  assert.deepEqual({ ...P.ERR_CODES }, { BAD_MESSAGE: 1, UNKNOWN_SESSION: 2, TOO_SLOW: 3, OVER_LIMIT: 4, UNAVAILABLE: 5 });
  assert.ok(Object.isFrozen(P.ERR_CODES));
});
test('상수 고정', () => {
  assert.equal(P.PROTO_VERSION, 1);
  assert.equal(P.FRAME_HEADER_BYTES, 8);
  assert.equal(P.PIECE_KEY_BYTES, 4 + 1 + 1 + 2 + 4 + 4);
  assert.equal(P.PIECE_KEY_BYTES, 16);
  assert.equal(P.MAX_REQUEST_ITEMS, 256);
  assert.equal(P.MAX_ERROR_TEXT, 256);
  assert.equal(P.MAX_PAYLOAD_BYTES, 4194304);
  assert.equal(P.PIECE_SEQ_MIN, 1);
  assert.equal(P.CHUNK_INDEX_LIMIT, 65536);
});

test('pieceKeyString', () => {
  assert.equal(P.pieceKeyString({ segmentId: 1, level: 2, lod: 3, chunkIndex: 4, tileX: -5, tileY: 6 }), '1:2:3:4:-5:6');
});

// 추월 묶음 = (segmentId, tileX, tileY, lod). level·chunkIndex 는 묶음 기준이 아니다.
test('overtakeGroup 표', () => {
  const base = { segmentId: 7, level: 1, lod: 2, chunkIndex: 3, tileX: -4, tileY: 5 };
  assert.equal(P.overtakeGroup(base), '7:-4:5:2');
  const same = [
    ['level 만 다름', { level: 3 }],
    ['chunkIndex 만 다름', { chunkIndex: 65535 }],
    ['level·chunkIndex 둘 다 다름', { level: 0, chunkIndex: 0 }],
  ];
  for (const [label, d] of same) assert.equal(P.overtakeGroup({ ...base, ...d }), P.overtakeGroup(base), label);
  const diff = [
    ['segmentId', { segmentId: 8 }],
    ['tileX', { tileX: -5 }],
    ['tileY', { tileY: 6 }],
    ['lod', { lod: 3 }],
    ['tileX 와 tileY 맞바꿈', { tileX: 5, tileY: -4 }],
  ];
  for (const [label, d] of diff) assert.notEqual(P.overtakeGroup({ ...base, ...d }), P.overtakeGroup(base), label);
  // 구분자 모호성 없음: 서로 다른 (tileX, tileY, lod) 조합이 같은 문자열이 되지 않는다.
  const seen = new Map();
  for (const tileX of [-1, 0, 1, 11]) for (const tileY of [-1, 0, 1, 11]) for (const lod of [0, 1, 11]) {
    const g = P.overtakeGroup({ segmentId: 1, level: 0, lod, chunkIndex: 0, tileX, tileY });
    assert.ok(!seen.has(g), `충돌 ${g}`);
    seen.set(g, 1);
  }
});
