import test from 'node:test';
import assert from 'node:assert/strict';
import { completedKeys, collectArrivals } from './arrival.mjs';
import { ClientRasterError } from './index.mjs';

// F-237 (2): negative cases that fail only for the intended reason. Each assertion pins the error
// code and message so a different throw site cannot satisfy it. All values are hard-coded.

const piece = (pieceSeq, chunkIndex = 0) => ({
  type: 'PIECE', pieceSeq,
  key: { segmentId: 7, level: 0, lod: 0, chunkIndex, tileX: 1, tileY: 2 },
});
const arrived = (extra = {}) => ({ type: 'LEVEL_ARRIVED', segmentId: 7, level: 0, pieceCount: 1, ...extra });

const piecesError = (re) => (e) => e instanceof ClientRasterError && e.code === 'piece' && re.test(e.message);

test('pieceSeq 0 after a valid piece is rejected as out of range', () => {
  assert.throws(() => completedKeys([piece(1), piece(0, 1)], arrived()), piecesError(/pieceSeq 범위 밖: 0$/));
  assert.throws(() => collectArrivals([piece(1), piece(0, 1)]), piecesError(/pieceSeq 범위 밖: 0$/));
});

test('pieceSeq 2^32 is rejected as out of range, 2^32-1 is accepted', () => {
  assert.throws(() => completedKeys([piece(4294967296)], arrived()), piecesError(/pieceSeq 범위 밖: 4294967296$/));
  assert.throws(() => collectArrivals([piece(1), piece(4294967296, 1)]), piecesError(/pieceSeq 범위 밖: 4294967296$/));
  assert.deepEqual(completedKeys([piece(4294967295)], arrived()), ['7.0.1.2.0.0']);
});

test('LEVEL_ARRIVED with only a wrong type is rejected for the type reason', () => {
  const msg = /LEVEL_ARRIVED 메시지가 아님$/;
  assert.throws(() => completedKeys([piece(1)], arrived({ type: 'MISSING' })), piecesError(msg));
  assert.throws(() => completedKeys([piece(1)], arrived({ type: 'PIECE' })), piecesError(msg));
  // the same object without a type (optional) or with the right type is accepted
  assert.deepEqual(completedKeys([piece(1)], arrived({ type: undefined })), ['7.0.1.2.0.0']);
  assert.deepEqual(completedKeys([piece(1)], arrived()), ['7.0.1.2.0.0']);
});

test('pieceCount larger than received pieces is rejected with the shortage message', () => {
  // guard at arrival.mjs:90. With maxSeq 5 and pieceCount 2 the window start (4) is >= 1, so only the
  // `pieceCount > size` half throws here; without it the error would name the missing pieceSeq 4 instead.
  assert.throws(() => completedKeys([piece(5)], arrived({ pieceCount: 2 })), piecesError(/pieceCount 2 만큼 조각을 받지 못함\(받은 조각 1\)$/));
  // window start below 1 (maxSeq 1, pieceCount 2) also reaches the same guard message
  assert.throws(() => completedKeys([piece(1)], arrived({ pieceCount: 2 })), piecesError(/pieceCount 2 만큼 조각을 받지 못함\(받은 조각 1\)$/));
});
