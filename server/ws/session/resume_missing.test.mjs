// 재전송 루프의 비용 시험(F-272). 벽시계 대신 결정적 횟수(loadPiece 호출 수·send 수)로 O(N+L) 을 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replayAfterHello } from './resume.mjs';

const N = 60000;
// 가짜 저장소: PIECE N 개 사이사이에 LEVEL_ARRIVED(창 1개 = 조각 1개) 를 둔 계획을 돌려준다. 총 메시지 2N.
function fakeStore() {
  const plan = [];
  for (let i = 1; i <= N; i++) {
    plan.push({ type: 'PIECE', pieceSeq: i, key: { segmentId: i, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 } });
    plan.push({ type: 'LEVEL_ARRIVED', segmentId: i, level: 0, pieceCount: 1, firstPieceSeq: i });
  }
  return { open: () => ({ sessionId: 1, resumed: true, nextPieceSeq: N + 1, reason: null }), resendPlan: () => plan };
}
const encode = (m) => new Uint8Array([m.type === 'WELCOME' ? 0 : m.type === 'PIECE' ? 1 : 2]);

test('loadPiece 전부 성공: loadPiece N 회, send 1+2N 회(O(N+L))', () => {
  let loads = 0; let sends = 0;
  const r = replayAfterHello({ store: fakeStore(), hello: { sessionId: 1, lastPieceSeq: 0 }, send: () => { sends++; }, loadPiece: () => { loads++; return new Uint8Array(2); }, encode });
  assert.equal(loads, N);
  assert.equal(sends, 1 + 2 * N);
  assert.equal(r.replayed, 2 * N);
  assert.equal(r.replayedBytes, 2 * N);
  assert.equal(r.stoppedAt, null);
});

test('loadPiece 전부 null: 첫 조각에서 멈춘다 — loadPiece 1 회, send 는 WELCOME 뿐', () => {
  let loads = 0; let sends = 0;
  const r = replayAfterHello({ store: fakeStore(), hello: { sessionId: 1, lastPieceSeq: 0 }, send: () => { sends++; }, loadPiece: () => { loads++; return null; }, encode });
  assert.equal(loads, 1);
  assert.equal(sends, 1);
  assert.equal(r.replayed, 0);
  assert.equal(r.stoppedAt, 1);
});

test('중간에 하나 빠지면 그 앞까지만: loadPiece k 회, 보낸 수는 앞 메시지 수와 같다', () => {
  const k = 30000;
  let loads = 0; let sends = 0; let n = 0;
  const r = replayAfterHello({ store: fakeStore(), hello: { sessionId: 1, lastPieceSeq: 0 }, send: () => { sends++; }, loadPiece: () => (++n === k ? null : (loads++, new Uint8Array(1))), encode });
  assert.equal(n, k);
  assert.equal(loads, k - 1);
  assert.equal(r.stoppedAt, k);
  assert.equal(r.replayed, 2 * (k - 1));
  assert.equal(sends, 1 + 2 * (k - 1));
});
