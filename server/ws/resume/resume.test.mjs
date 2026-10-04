import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from './index.mjs';
import { overtakeGroup, pieceKeyString, PIECE_SEQ_MIN } from '../../../contracts/proto/index.mjs';

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

// ---- F-185: 추월 묶음은 계약 overtakeGroup 하나로 ----
const K = (level, chunkIndex, o = {}) => ({ segmentId: 3, level, lod: 0, chunkIndex, tileX: 4, tileY: -1, ...o });

test('F-185: 수준 3 chunk 0 을 보낸 뒤 수준 1 chunk 1 은 false', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.equal(overtakeGroup(K(3, 0)), overtakeGroup(K(1, 1))); // 계약상 같은 묶음
  st.recordSent(sessionId, K(3, 0), 1, 10);
  assert.equal(st.shouldSend(sessionId, K(1, 1)), false);
  // 재접속 경로에서도 추월당한 낮은 수준은 다시 나가지 않는다
  st.recordSent(sessionId, K(1, 1, { tileX: 9 }), 2, 10);
  st.recordSent(sessionId, K(3, 0, { tileX: 9 }), 3, 10);
  st.open({ sessionId, lastPieceSeq: 1 });
  assert.equal(st.shouldSend(sessionId, K(1, 1, { tileX: 9 })), false);
  assert.equal(st.shouldSend(sessionId, K(3, 0, { tileX: 9 })), true);
});

// 표: [먼저 보낸 키, 물어보는 키, shouldSend 기대값]. 한 줄마다 새 세션.
const PAIRS = [
  [K(3, 0), K(1, 1), false], // 다른 chunk 라도 낮은 수준은 추월당함(F-185 원 사례)
  [K(3, 0), K(1, 0), false], // 같은 chunk 낮은 수준
  [K(3, 0), K(3, 0), false], // 같은 키 = 이미 보냄
  [K(3, 0), K(3, 7), true], // 같은 수준 다른 chunk = 같은 조각 집합의 나머지
  [K(1, 5), K(2, 0), true], // 더 높은 수준은 교체로 나간다
  [K(2, 0), K(2, 0, { level: 3, chunkIndex: 65535 }), true], // 높은 수준·큰 chunk
  [K(3, 0), K(1, 0, { lod: 1 }), true], // lod 다르면 다른 묶음
  [K(3, 0), K(1, 0, { tileX: 5 }), true], // tileX 다르면 다른 묶음
  [K(3, 0), K(1, 0, { tileY: 0 }), true], // tileY 다르면 다른 묶음
  [K(3, 0), K(1, 0, { segmentId: 4 }), true], // segment 다르면 다른 묶음
  [K(0, 2), K(0, 3), true], // 수준 0 같은 수준 다른 chunk
  [K(2, 9), K(0, 9, { chunkIndex: 0 }), false], // 수준 2 뒤 수준 0 어떤 chunk 도 false
];

test('F-185: 키 쌍 표 판정 고정(12쌍), 판정이 overtakeGroup 과 일치', () => {
  assert.ok(PAIRS.length >= 8);
  const got = PAIRS.map(([a, b]) => {
    const { st } = mk();
    const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
    st.recordSent(sessionId, a, 1, 1);
    return st.shouldSend(sessionId, b);
  });
  assert.deepEqual(got, PAIRS.map((p) => p[2]));
  // 묶음이 다르면 항상 true, 같은 묶음이면 수준 비교로만 갈린다(같은 키 제외)
  for (const [a, b, want] of PAIRS) {
    if (overtakeGroup(a) !== overtakeGroup(b)) assert.equal(want, true);
    else if (pieceKeyString(a) !== pieceKeyString(b)) assert.equal(want, b.level >= a.level);
  }
});

// ---- F-184: pieceSeq 는 1 부터 ----
test('F-184: 첫 조각 seq 1 기록 후 lastPieceSeq 0 재접속 -> 재전송 후보', () => {
  const { st } = mk();
  const { sessionId, nextPieceSeq } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.equal(nextPieceSeq, PIECE_SEQ_MIN);
  assert.equal(PIECE_SEQ_MIN, 1);
  st.recordSent(sessionId, key(1), nextPieceSeq, 10);
  const r = st.open({ sessionId, lastPieceSeq: 0 });
  assert.equal(r.resumed, true);
  assert.equal(r.nextPieceSeq, 2);
  assert.deepEqual(st.unacked(sessionId), [{ seq: 1, key: key(1) }]);
  assert.equal(st.shouldSend(sessionId, key(1)), true);
});

test('F-184: seq 0 recordSent 는 RangeError, 순번 역행도 RangeError', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.throws(() => st.recordSent(sessionId, key(1), 0, 10), RangeError);
  assert.equal(st.stats(sessionId).entries, 0);
  st.recordSent(sessionId, key(1), 5, 10);
  assert.throws(() => st.recordSent(sessionId, key(2), 5, 10), RangeError);
  assert.throws(() => st.recordSent(sessionId, key(2), 4, 10), RangeError);
  assert.equal(st.recordSent(sessionId, key(2), 6, 10), true);
});

// ---- F-195: ack clamp ----
test('F-195: 보낸 최대 순번보다 큰 upToSeq 는 그 순번으로 줄인다', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  st.ack(sessionId, 50); // 아무것도 안 보냈을 때: 0 으로 줄어든다
  st.recordSent(sessionId, key(1), 1, 7);
  st.ack(sessionId, 0); // 늦게 온 낮은 ack: 아무것도 확인하지 않는다
  assert.deepEqual(st.unacked(sessionId).map((u) => u.seq), [1]); // clamp 없으면 seq 1 이 확인된 것으로 사라진다
  assert.equal(st.stats(sessionId).retainedBytes, 7);
  st.recordSent(sessionId, key(2), 2, 7);
  st.recordSent(sessionId, key(3), 3, 7);
  st.ack(sessionId, 9999);
  assert.equal(st.unacked(sessionId).length, 0);
  assert.equal(st.stats(sessionId).retainedBytes, 0);
  st.recordSent(sessionId, key(4), 4, 7);
  st.recordSent(sessionId, key(5), 5, 7);
  st.ack(sessionId, 3);
  assert.deepEqual(st.unacked(sessionId).map((u) => u.seq), [4, 5]);
  assert.equal(st.open({ sessionId, lastPieceSeq: 0 }).resumed, true);
  assert.equal(st.shouldSend(sessionId, key(4)), true); // 4·5 는 아직 못 받은 조각 = 재전송 후보
  assert.equal(st.stats(sessionId).retainedBytes, 14);
  // 재접속도 같은 clamp
  st.open({ sessionId, lastPieceSeq: 9999 });
  st.recordSent(sessionId, key(6), 6, 7);
  st.ack(sessionId, 5);
  assert.deepEqual(st.unacked(sessionId).map((u) => u.seq), [6]);
});

// ---- F-192: 보관 바이트·상한 ----
test('F-192: 100 KB 조각 2000개 기록·전부 ack 후 보관 바이트 0, 판정은 유지', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  const PIECE = 100 * 1024;
  const N = 2000;
  for (let i = 1; i <= N; i++) {
    const k = { segmentId: i, level: 2, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 };
    assert.equal(st.recordSent(sessionId, k, i, new Uint8Array(PIECE)), true);
  }
  assert.equal(st.stats(sessionId).retainedBytes, N * PIECE); // 204,800,000 B
  assert.equal(st.retainedBytes(), N * PIECE);
  st.ack(sessionId, 1000);
  assert.equal(st.stats(sessionId).retainedBytes, 1000 * PIECE);
  st.ack(sessionId, N);
  assert.deepEqual(st.stats(sessionId), { entries: N, retainedBytes: 0, unacked: 0 });
  assert.equal(st.retainedBytes(), 0);
  for (const i of [1, 1000, N]) {
    assert.equal(st.shouldSend(sessionId, { segmentId: i, level: 2, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 }), false);
    assert.equal(st.shouldSend(sessionId, { segmentId: i, level: 1, lod: 0, chunkIndex: 3, tileX: 0, tileY: 0 }), false);
    assert.equal(st.shouldSend(sessionId, { segmentId: i, level: 3, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 }), true);
  }
});

test('F-192: maxEntriesPerSession 초과 시 가장 오래 전에 ack 된 항목부터 축출, 없으면 거부', () => {
  const { st } = mk({ maxEntriesPerSession: 3 });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  for (let i = 1; i <= 3; i++) assert.equal(st.recordSent(sessionId, key(i), i, 10), true);
  assert.equal(st.recordSent(sessionId, key(4), 4, 10), false); // ack 된 것 없음 -> 거부, 변화 없음
  assert.deepEqual(st.stats(sessionId), { entries: 3, retainedBytes: 30, unacked: 3 });
  assert.equal(st.shouldSend(sessionId, key(4)), true);
  st.ack(sessionId, 2); // 1, 2 확인
  assert.equal(st.recordSent(sessionId, key(4), 4, 10), true); // 1 축출
  assert.deepEqual(st.stats(sessionId), { entries: 3, retainedBytes: 20, unacked: 2 });
  // 축출된 항목: 그 묶음 최고 수준과 같은 수준이면 '같은 수준 다른 chunk' 와 구별이 안 돼 다시 true(헤더에 적은 대가)
  assert.equal(st.shouldSend(sessionId, key(1)), true);
  assert.equal(st.shouldSend(sessionId, key(2)), false); // 아직 남은 ack 항목
  st.recordSent(sessionId, { ...key(1), level: 1 }, 5, 0); // 가장 오래된 ack 항목(2) 축출
  st.ack(sessionId, 5);
  assert.equal(st.stats(sessionId).entries, 3);
  assert.equal(st.shouldSend(sessionId, key(2)), true);
  assert.equal(st.shouldSend(sessionId, key(1)), false); // 더 높은 수준이 나간 묶음의 낮은 수준은 축출 뒤에도 false(groupMax)
  // 남은 항목 3,4,5 전부 ack 됨 -> 새 기록마다 가장 오래된 것(3)부터 축출
  assert.equal(st.recordSent(sessionId, key(6), 6, 10), true);
  assert.equal(st.recordSent(sessionId, key(7), 7, 10), true);
  assert.equal(st.recordSent(sessionId, key(8), 8, 10), true); // 3,4,5 축출, 6,7,8 미확인
  assert.deepEqual(st.unacked(sessionId).map((u) => u.seq), [6, 7, 8]);
  assert.equal(st.recordSent(sessionId, key(9), 9, 10), false); // 남은 ack 항목 없음
  assert.deepEqual(st.stats(sessionId), { entries: 3, retainedBytes: 30, unacked: 3 });
});

test('F-192: maxBytesPerSession 은 미확인 바이트 합 기준, ack 뒤 다시 받는다', () => {
  const { st } = mk({ maxBytesPerSession: 250 });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.equal(st.recordSent(sessionId, key(1), 1, 100), true);
  assert.equal(st.recordSent(sessionId, key(2), 2, new Uint8Array(150)), true); // 250 = 상한(포함)
  assert.equal(st.recordSent(sessionId, key(3), 3, 1), false);
  assert.equal(st.stats(sessionId).retainedBytes, 250);
  st.ack(sessionId, 1);
  assert.equal(st.recordSent(sessionId, key(3), 3, 100), true);
  assert.deepEqual(st.stats(sessionId), { entries: 3, retainedBytes: 250, unacked: 2 });
  assert.throws(() => createSessionStore({ maxSessions: 1, ttlMs: 1, now: () => 0, maxBytesPerSession: 0 }), RangeError);
});

test('F-192: 재전송으로 같은 key 를 다시 기록하면 이전 바이트를 대체한다', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  st.recordSent(sessionId, key(1), 1, 40);
  st.recordSent(sessionId, key(2), 2, 40);
  st.open({ sessionId, lastPieceSeq: 1 });
  assert.equal(st.stats(sessionId).retainedBytes, 40);
  assert.equal(st.shouldSend(sessionId, key(2)), true);
  st.recordSent(sessionId, key(2), 3, 40);
  assert.deepEqual(st.stats(sessionId), { entries: 2, retainedBytes: 40, unacked: 1 });
  assert.deepEqual(st.unacked(sessionId).map((u) => u.seq), [3]);
});

test('sweep 은 만료된 앞부분만 지운다(최근 세션은 유지)', () => {
  const { c, st } = mk({ maxSessions: 1000, ttlMs: 100 });
  const ids = [];
  for (let i = 0; i < 10; i++) { ids.push(st.open({ sessionId: 0, lastPieceSeq: 0 }).sessionId); c.t += 20; }
  // t = 시작+200: 앞의 5개(경과 ≥ 100)만 만료
  assert.equal(st.size(), 4);
  st.ack(ids[6], 0); // ids[6] 를 최근으로
  c.t += 50;
  assert.equal(st.size(), 3); // ids[7](경과 110) 만료, ids[8]·ids[9]·ids[6] 유지
  assert.equal(st.open({ sessionId: ids[6], lastPieceSeq: 0 }).resumed, true);
  assert.equal(st.open({ sessionId: ids[7], lastPieceSeq: 0 }).resumed, false);
});
