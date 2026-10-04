import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from './index.mjs';

test('메시지 종류 9개, 방향·고정 크기 표가 빠짐없다', () => {
  assert.equal(Object.keys(P.MSG).length, 9);
  for (const v of Object.values(P.MSG)) assert.ok(P.DIRECTION[v]);
  assert.deepEqual(Object.keys(P.FIXED_PAYLOAD_BYTES).map(Number).sort(), [1, 2, 4, 5, 7, 8]);
  assert.equal(P.FIXED_PAYLOAD_BYTES[P.MSG.VIEW_UPDATE], 4 + 12 + 16 + 4 + 2 + 2);
});
test('상수 고정', () => {
  assert.equal(P.FRAME_HEADER_BYTES, 8);
  assert.equal(P.PIECE_KEY_BYTES, 4 + 1 + 1 + 2 + 4 + 4);
  assert.equal(P.MAX_REQUEST_ITEMS, 256);
  assert.equal(P.MAX_PAYLOAD_BYTES, 4194304);
});
test('pieceKeyString', () => {
  assert.equal(P.pieceKeyString({ segmentId: 1, level: 2, lod: 3, chunkIndex: 4, tileX: -5, tileY: 6 }), '1:2:3:4:-5:6');
});
