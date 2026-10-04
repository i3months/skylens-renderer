import test from 'node:test';
import assert from 'node:assert/strict';
import { collectArrivals } from './arrival.mjs';
import { ClientRasterError } from './index.mjs';

// WELCOME 검사(F-240): sessionId >= 1, 그리고 재접속 시 호출 규약(세션의 수신 이력 전체)을 못박는다.

const isPiece = (e) => e instanceof ClientRasterError && e.code === 'piece';
const P = (pieceSeq, segmentId, level, chunkIndex) => ({ type: 'PIECE', pieceSeq, key: { segmentId, level, lod: 0, chunkIndex, tileX: 0, tileY: 0 }, chunk: Uint8Array.of(1) });
const LA = (segmentId, level, pieceCount) => ({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount });
const W = (sessionId, resumed, nextPieceSeq) => ({ type: 'WELCOME', sessionId, resumed, nextPieceSeq });

test('WELCOME sessionId 0 은 거부(서버는 0 을 발급하지 않음), 1 과 u32 최댓값은 통과', () => {
  assert.throws(() => collectArrivals([W(0, false, 1)]), (e) => isPiece(e) && /WELCOME sessionId 는 u32 정수여야 함/.test(e.message));
  assert.throws(() => collectArrivals([W(1, false, 1), W(0, true, 1)]), (e) => isPiece(e) && /WELCOME sessionId 는 u32 정수여야 함/.test(e.message));
  assert.deepEqual(collectArrivals([W(1, false, 1)]), { keys: [], arrived: [] });
  assert.deepEqual(collectArrivals([W(0xffffffff, false, 1)]), { keys: [], arrived: [] });
});

test('호출 규약: 세션의 수신 이력 전체(앞 연결의 첫 WELCOME 포함)는 통과', () => {
  const history = [W(42, false, 1), P(1, 9, 1, 0), P(2, 9, 1, 1), W(42, true, 3), P(2, 9, 1, 1), P(3, 9, 1, 2), LA(9, 1, 3)];
  assert.deepEqual(collectArrivals(history), {
    keys: ['9.1.0.0.0.0', '9.1.0.0.0.1', '9.1.0.0.0.2'],
    arrived: [{ segmentId: 9, level: 1, keys: ['9.1.0.0.0.0', '9.1.0.0.0.1', '9.1.0.0.0.2'] }],
  });
});

test('호출 규약: 재접속 뒤 새 연결의 메시지만 넣으면(첫 WELCOME 이 resumed=true) 전체 거부', () => {
  const onlyNew = [W(42, true, 3), P(2, 9, 1, 1), P(3, 9, 1, 2), LA(9, 1, 3)];
  assert.throws(() => collectArrivals(onlyNew), (e) => isPiece(e) && /resumed=true 인데 앞 WELCOME 의 sessionId 가 없음/.test(e.message));
});
