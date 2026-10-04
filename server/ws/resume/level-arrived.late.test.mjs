// LEVEL_ARRIVED 를 조각 확인(ack) 뒤에 처음 기록하는 경우의 확인 규칙(F-238 ⑤). 시계는 고정값, 기대값은 손으로 적은 숫자.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from './index.mjs';

const store = () => createSessionStore({ maxSessions: 4, ttlMs: 60_000, now: () => 1000, randomId: () => 77 });
const key = (seg, level, c) => ({ segmentId: seg, level, lod: 0, chunkIndex: c, tileX: 1, tileY: -2 });
const chunkOf = (seq) => Uint8Array.of(seq, 0x5a);
const la = (segmentId, level, firstPieceSeq, pieceCount) => ({ type: 'LEVEL_ARRIVED', segmentId, level, firstPieceSeq, pieceCount });

/** 구간 9 수준 1 의 조각 seq 3·4·5 만 기록한다(LEVEL_ARRIVED 는 아직). */
function sendPieces(st, sid) {
  for (const [seq, c] of [[3, 0], [4, 1], [5, 2]]) assert.equal(st.recordSent(sid, key(9, 1, c), seq, chunkOf(seq)), true);
}

test('늦게 처음 기록: ackedUpTo == 창 끝(5)이면 LEVEL_ARRIVED(9,1,3,3) 를 남긴다', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  sendPieces(st, sid);
  st.ack(sid, 5);
  assert.equal(st.recordLevelArrived(sid, la(9, 1, 3, 3)), true);
  assert.deepEqual(st.open({ sessionId: sid, lastPieceSeq: 5 }), { sessionId: 77, resumed: true, nextPieceSeq: 6, reason: null });
  assert.deepEqual(st.resendPlan(sid), [la(9, 1, 3, 3)]);
});

test('늦게 처음 기록: ackedUpTo(6) > 창 끝(5)이면 남기지 않는다', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  sendPieces(st, sid);
  assert.equal(st.recordSent(sid, key(10, 0, 0), 6, chunkOf(6)), true);
  st.ack(sid, 6);
  assert.equal(st.recordLevelArrived(sid, la(9, 1, 3, 3)), true);
  // 열기 전에 바로 확인한다: open 의 ack 정리가 잘못 남긴 기록을 가리지 못하게.
  assert.deepEqual(st.resendPlan(sid), []);
  assert.deepEqual(st.open({ sessionId: sid, lastPieceSeq: 6 }), { sessionId: 77, resumed: true, nextPieceSeq: 7, reason: null });
  assert.deepEqual(st.resendPlan(sid), []);
});
