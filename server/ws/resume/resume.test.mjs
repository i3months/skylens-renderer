import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from './index.mjs';

const mk = (o = {}) => {
  const c = { t: 1000 };
  let n = 100;
  const st = createSessionStore({ maxSessions: 4, ttlMs: 60000, now: () => c.t, randomId: () => n++, ...o });
  return { c, st };
};
const key = (i, level = 0) => ({ segmentId: 7, level, lod: 0, chunkIndex: i, tileX: i % 5, tileY: 2 });

test('새 세션과 알 수 없는 id', () => {
  const { st } = mk();
  const a = st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.deepEqual(a, { sessionId: 100, resumed: false, nextPieceSeq: 1, reason: null });
  const b = st.open({ sessionId: 999, lastPieceSeq: 5 });
  assert.equal(b.resumed, false);
  assert.equal(b.reason, 'UNKNOWN_SESSION');
  assert.notEqual(b.sessionId, 999);
  assert.equal(b.nextPieceSeq, 1);
});

test('합성: 100조각 전송, 70 까지 수신 후 끊김, 재접속 -> 중복 0 누락 0', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  for (let i = 1; i <= 100; i++) {
    assert.equal(st.shouldSend(sessionId, key(i)), true);
    st.recordSent(sessionId, key(i), i, 50);
    assert.equal(st.shouldSend(sessionId, key(i)), false); // 기록 후 두 번째 true 없음
  }
  assert.equal(st.unacked(sessionId).length, 100);
  st.ack(sessionId, 40);
  assert.equal(st.unacked(sessionId).length, 60);
  const r = st.open({ sessionId, lastPieceSeq: 70 });
  assert.equal(r.resumed, true);
  assert.equal(r.reason, null);
  assert.equal(r.nextPieceSeq, 101);
  const un = st.unacked(sessionId);
  assert.equal(un.length, 30);
  assert.deepEqual(un.map((u) => u.seq), Array.from({ length: 30 }, (_, i) => 71 + i));
  const resent = [];
  for (let i = 1; i <= 100; i++) if (st.shouldSend(sessionId, key(i))) resent.push(i);
  assert.equal(resent.length, 30); // 이미 받은 70개는 중복 전송 0
  assert.deepEqual(resent, un.map((u) => u.seq)); // 누락 0
  let seq = r.nextPieceSeq;
  for (const i of resent) st.recordSent(sessionId, key(i), seq++, 50);
  for (let i = 1; i <= 100; i++) assert.equal(st.shouldSend(sessionId, key(i)), false);
  assert.equal(st.unacked(sessionId).length, 30);
  assert.equal(st.unacked(sessionId)[0].seq, 101);
});

test('추월 규칙: 높은 수준을 보냈으면 낮은·같은 수준 false', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  st.recordSent(sessionId, key(1, 1), 1, 10);
  assert.equal(st.shouldSend(sessionId, key(1, 0)), false);
  assert.equal(st.shouldSend(sessionId, key(1, 1)), false);
  assert.equal(st.shouldSend(sessionId, key(1, 2)), true);
  assert.equal(st.shouldSend(sessionId, { ...key(1, 0), lod: 1 }), true); // 다른 lod 는 별개
  assert.equal(st.shouldSend(sessionId, key(2, 0)), true);
  // 재접속 후에도 추월당한 낮은 수준은 후보가 아님
  st.recordSent(sessionId, key(3, 0), 2, 10);
  st.recordSent(sessionId, key(3, 2), 3, 10);
  st.open({ sessionId, lastPieceSeq: 1 });
  assert.equal(st.shouldSend(sessionId, key(3, 0)), false);
  assert.equal(st.shouldSend(sessionId, key(3, 2)), true);
});

test('TTL 만료는 가짜 시계로', () => {
  const { c, st } = mk({ ttlMs: 1000 });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  c.t += 999;
  assert.equal(st.open({ sessionId, lastPieceSeq: 0 }).resumed, true); // 활동으로 갱신
  c.t += 1000;
  const r = st.open({ sessionId, lastPieceSeq: 0 });
  assert.equal(r.resumed, false);
  assert.equal(r.reason, 'UNKNOWN_SESSION');
});

test('세션 상한: 가장 오래 쓰이지 않은 세션을 쫓아낸다, 만료분 먼저', () => {
  const { c, st } = mk({ maxSessions: 2, ttlMs: 1000 });
  const a = st.open({ sessionId: 0, lastPieceSeq: 0 }).sessionId;
  c.t += 10;
  const b = st.open({ sessionId: 0, lastPieceSeq: 0 }).sessionId;
  c.t += 10;
  st.ack(a, 0); // a 가 최근
  st.open({ sessionId: 0, lastPieceSeq: 0 }); // b 퇴출
  assert.equal(st.size(), 2);
  assert.equal(st.open({ sessionId: b, lastPieceSeq: 0 }).resumed, false);
  assert.equal(st.size(), 2);
  c.t += 5000; // 전부 만료
  st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.equal(st.size(), 1);
});

test('close 와 입력 검사', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  st.close(sessionId);
  assert.equal(st.open({ sessionId, lastPieceSeq: 0 }).resumed, false);
  assert.throws(() => st.open({ sessionId: -1, lastPieceSeq: 0 }), RangeError);
  assert.throws(() => createSessionStore({ maxSessions: 0, ttlMs: 1, now: () => 0 }), RangeError);
});

test('클라이언트가 보낸 적 없는 순번을 주장하면 보낸 최대 순번으로 줄인다', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  st.recordSent(sessionId, key(1), 1, 1);
  st.recordSent(sessionId, key(2), 2, 1);
  st.open({ sessionId, lastPieceSeq: 9999 });
  assert.equal(st.unacked(sessionId).length, 0);
  st.recordSent(sessionId, key(3), 3, 1);
  assert.equal(st.unacked(sessionId).length, 1);
});
