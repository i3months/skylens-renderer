import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createSessionStore, DEFAULT_MAX_ENTRIES_PER_SESSION, DEFAULT_MAX_BYTES_PER_SESSION } from './index.mjs';
import { encodeMessage } from '../../proto/codec/index.mjs';
import { decodeMessage } from '../../../client/proto/index.mjs'; // WELCOME 은 s→c 라 클라이언트 코덱으로 복호
import { overtakeGroup, PIECE_SEQ_MIN } from '../../../contracts/proto/index.mjs';

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

// 표: [먼저 보낸 키, 물어보는 키, shouldSend 기대값, 같은 추월 묶음인가]. 한 줄마다 새 세션. 기대값 두 열 모두 손으로 적었다.
const PAIRS = [
  [K(3, 0), K(1, 1), false, true], // 다른 chunk 라도 낮은 수준은 추월당함(F-185 원 사례)
  [K(3, 0), K(1, 0), false, true], // 같은 chunk 낮은 수준
  [K(3, 0), K(3, 0), false, true], // 같은 키 = 이미 보냄
  [K(3, 0), K(3, 7), true, true], // 같은 수준 다른 chunk = 같은 조각 집합의 나머지
  [K(1, 5), K(2, 0), true, true], // 더 높은 수준은 교체로 나간다
  [K(2, 0), K(2, 0, { level: 3, chunkIndex: 65535 }), true, true], // 높은 수준·큰 chunk
  [K(3, 0), K(1, 0, { lod: 1 }), true, false], // lod 다르면 다른 묶음
  [K(3, 0), K(1, 0, { tileX: 5 }), true, false], // tileX 다르면 다른 묶음
  [K(3, 0), K(1, 0, { tileY: 0 }), true, false], // tileY 다르면 다른 묶음
  [K(3, 0), K(1, 0, { segmentId: 4 }), true, false], // segment 다르면 다른 묶음
  [K(0, 2), K(0, 3), true, true], // 수준 0 같은 수준 다른 chunk
  [K(2, 9), K(0, 9, { chunkIndex: 0 }), false, true], // 수준 2 뒤 수준 0 어떤 chunk 도 false
];

test('F-185: 키 쌍 표 판정 고정(12쌍), 묶음 판정도 손으로 적은 열과 일치 (F-201)', () => {
  assert.equal(PAIRS.length, 12);
  const got = PAIRS.map(([a, b]) => {
    const { st } = mk();
    const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
    st.recordSent(sessionId, a, 1, 1);
    return st.shouldSend(sessionId, b);
  });
  assert.deepEqual(got, PAIRS.map((p) => p[2]));
  assert.deepEqual(PAIRS.map(([a, b]) => overtakeGroup(a) === overtakeGroup(b)), PAIRS.map((p) => p[3]));
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
  const PIECE = 100 * 1024;
  const N = 2000;
  const { st } = mk({ maxBytesPerSession: N * PIECE }); // 기본 상한(64 MiB)보다 큰 실험이라 명시
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  for (let i = 1; i <= N; i++) {
    const k = { segmentId: i, level: 2, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 };
    assert.equal(st.recordSent(sessionId, k, i, new Uint8Array(PIECE)), true);
  }
  assert.equal(st.stats(sessionId).retainedBytes, N * PIECE); // 204,800,000 B
  assert.equal(st.retainedBytes(), N * PIECE);
  st.ack(sessionId, 1000);
  assert.equal(st.stats(sessionId).retainedBytes, 1000 * PIECE);
  st.ack(sessionId, N);
  assert.deepEqual(st.stats(sessionId), { entries: N, retainedBytes: 0, unacked: 0, groups: N, levels: 0 });
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
  assert.deepEqual(st.stats(sessionId), { entries: 3, retainedBytes: 30, unacked: 3, groups: 3, levels: 0 });
  assert.equal(st.shouldSend(sessionId, key(4)), true);
  st.ack(sessionId, 2); // 1, 2 확인
  assert.equal(st.recordSent(sessionId, key(4), 4, 10), true); // 1 축출
  assert.deepEqual(st.stats(sessionId), { entries: 3, retainedBytes: 20, unacked: 2, groups: 3, levels: 0 });
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
  // key(6)(tileX 1) 은 seq 5 의 수준 1 조각과 같은 묶음의 낮은 수준이라 추월당했다 -> 재전송 후보 아님(F-199).
  // 수준 1 항목이 축출돼도 key(6) 이 그 묶음에 남아 groupMax 가 유지된다.
  assert.deepEqual(st.unacked(sessionId).map((u) => u.seq), [7, 8]);
  assert.equal(st.stats(sessionId).unacked, 3); // 계측 수는 추월당한 미확인 항목도 센다
  assert.equal(st.recordSent(sessionId, key(9), 9, 10), false); // 남은 ack 항목 없음
  assert.deepEqual(st.stats(sessionId), { entries: 3, retainedBytes: 30, unacked: 3, groups: 3, levels: 0 });
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
  assert.deepEqual(st.stats(sessionId), { entries: 3, retainedBytes: 250, unacked: 2, groups: 3, levels: 0 });
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
  assert.deepEqual(st.stats(sessionId), { entries: 2, retainedBytes: 40, unacked: 1, groups: 2, levels: 0 });
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

// ---- F-192: 유한 기본 상한·groupMax 축출 ----
const bare = () => createSessionStore({ maxSessions: 2, ttlMs: 60000, now: () => 0 }); // 상한 옵션 없음

test('F-192: 상한 옵션 없이 만든 저장소도 항목 수 상한을 넘는 recordSent 는 false', () => {
  assert.equal(DEFAULT_MAX_ENTRIES_PER_SESSION, 65536);
  const st = bare();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  const k = (i) => ({ segmentId: i, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 });
  for (let i = 1; i <= DEFAULT_MAX_ENTRIES_PER_SESSION; i++) assert.equal(st.recordSent(sessionId, k(i), i, 0), true);
  const next = DEFAULT_MAX_ENTRIES_PER_SESSION + 1;
  assert.equal(st.recordSent(sessionId, k(next), next, 0), false); // ack 된 것이 없어 축출 불가
  assert.equal(st.stats(sessionId).entries, DEFAULT_MAX_ENTRIES_PER_SESSION);
  st.ack(sessionId, 1);
  assert.equal(st.recordSent(sessionId, k(next), next, 0), true); // 확인된 1 을 축출
  assert.equal(st.stats(sessionId).entries, DEFAULT_MAX_ENTRIES_PER_SESSION);
});

test('F-192: 상한 옵션 없이 만든 저장소도 바이트 상한을 넘는 recordSent 는 false, 전부 ack 후 보관 0', () => {
  assert.equal(DEFAULT_MAX_BYTES_PER_SESSION, 64 * 1024 * 1024);
  const st = bare();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  const k = (i) => ({ segmentId: i, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 });
  const quarter = DEFAULT_MAX_BYTES_PER_SESSION / 4;
  for (let i = 1; i <= 4; i++) assert.equal(st.recordSent(sessionId, k(i), i, quarter), true); // 상한과 같음(포함)
  assert.equal(st.recordSent(sessionId, k(5), 5, 1), false);
  assert.equal(st.recordSent(sessionId, k(5), 5, new Uint8Array(1)), false);
  assert.deepEqual(st.stats(sessionId), { entries: 4, retainedBytes: DEFAULT_MAX_BYTES_PER_SESSION, unacked: 4, groups: 4, levels: 0 });
  st.ack(sessionId, 4);
  assert.equal(st.stats(sessionId).retainedBytes, 0);
  assert.equal(st.retainedBytes(), 0);
  assert.equal(st.recordSent(sessionId, k(5), 5, quarter), true);
  st.ack(sessionId, 5);
  assert.equal(st.retainedBytes(), 0);
});

test('F-192: 상한은 언제나 유한 — Infinity·0·비정수는 RangeError', () => {
  const base = { maxSessions: 1, ttlMs: 1, now: () => 0 };
  for (const bad of [Infinity, 0, -1, 1.5, NaN, '10']) {
    assert.throws(() => createSessionStore({ ...base, maxEntriesPerSession: bad }), RangeError, String(bad));
    assert.throws(() => createSessionStore({ ...base, maxBytesPerSession: bad }), RangeError, String(bad));
  }
});

test('F-192: groupMax 는 묶음의 마지막 항목이 축출될 때 함께 지운다(groups ≤ 항목 상한)', () => {
  const { st } = mk({ maxEntriesPerSession: 2 });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  const G = (level, tileX, chunkIndex = 0) => ({ segmentId: 1, level, lod: 0, chunkIndex, tileX, tileY: 0 });
  // 묶음 tileX=0: 수준 1 과 수준 3 두 항목
  st.recordSent(sessionId, G(1, 0), 1, 5);
  st.recordSent(sessionId, G(3, 0, 1), 2, 5);
  st.ack(sessionId, 2);
  assert.equal(st.stats(sessionId).groups, 1);
  // 새 묶음 기록 -> 가장 오래된 확인 항목(수준 1)만 축출, 수준 3 이 남아 groupMax 유지
  assert.equal(st.recordSent(sessionId, G(0, 1), 3, 5), true);
  assert.deepEqual(st.stats(sessionId), { entries: 2, retainedBytes: 5, unacked: 1, groups: 2, levels: 0 });
  assert.equal(st.shouldSend(sessionId, G(1, 0)), false); // 축출됐지만 묶음 최고 수준 3 이 남음
  assert.equal(st.shouldSend(sessionId, G(2, 0, 5)), false);
  // 묶음 tileX=0 의 마지막 항목(수준 3)이 축출되면 groupMax 도 사라진다
  st.ack(sessionId, 3);
  assert.equal(st.recordSent(sessionId, G(0, 2), 4, 5), true);
  assert.deepEqual(st.stats(sessionId), { entries: 2, retainedBytes: 5, unacked: 1, groups: 2, levels: 0 });
  assert.equal(st.shouldSend(sessionId, G(1, 0)), true); // 헤더에 적은 대가
  // 많은 묶음을 흘려도 groups 는 항목 상한을 넘지 않는다
  for (let i = 5; i <= 1004; i++) {
    st.ack(sessionId, i - 1);
    assert.equal(st.recordSent(sessionId, G(0, 100 + i), i, 1), true);
    assert.ok(st.stats(sessionId).groups <= 2);
  }
});

// ---- F-199: unacked 는 추월당한 조각을 빼고 돌려준다 ----
test('F-199: 수준 1 기록 -> ack 전 같은 묶음 수준 2 기록 -> 재접속: 수준 1 없음, 같은 수준 다른 chunk 는 남음', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  st.recordSent(sessionId, K(1, 0), 1, 10);
  st.recordSent(sessionId, K(1, 1), 2, 10);
  st.recordSent(sessionId, K(1, 0, { tileX: 8 }), 3, 10); // 다른 묶음의 수준 1 = 추월 아님
  st.recordSent(sessionId, K(2, 0), 4, 10);
  st.recordSent(sessionId, K(2, 1), 5, 10);
  const r = st.open({ sessionId, lastPieceSeq: 0 });
  assert.equal(r.resumed, true);
  assert.deepEqual(st.unacked(sessionId), [
    { seq: 3, key: K(1, 0, { tileX: 8 }) },
    { seq: 4, key: K(2, 0) },
    { seq: 5, key: K(2, 1) },
  ]);
  // 재전송 후보 = shouldSend true 와 같다
  for (const k of [K(1, 0), K(1, 1)]) assert.equal(st.shouldSend(sessionId, k), false);
  for (const u of st.unacked(sessionId)) assert.equal(st.shouldSend(sessionId, u.key), true);
  assert.equal(st.stats(sessionId).unacked, 5); // 계측은 보관 중인 미확인 전부
  // 같은 묶음에 더 높은 수준이 오면 수준 2 도 후보에서 빠진다
  st.recordSent(sessionId, K(3, 0), 6, 10);
  assert.deepEqual(st.unacked(sessionId).map((u) => u.seq), [3, 6]);
});

// ---- F-197: 같은 key·같은 seq 재기록은 멱등 ----
test('F-197: 같은 key·같은 seq 재기록은 true, 상태 하나만 남는다; 다른 key 나 다른 seq 는 RangeError', () => {
  const { st } = mk({ maxBytesPerSession: 100 });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.equal(st.recordSent(sessionId, key(1), 1, 30), true);
  assert.equal(st.recordSent(sessionId, key(2), 2, 30), true);
  assert.equal(st.recordSent(sessionId, key(1), 1, 30), true); // 재시도
  assert.equal(st.recordSent(sessionId, key(2), 2, new Uint8Array(30)), true);
  assert.deepEqual(st.stats(sessionId), { entries: 2, retainedBytes: 60, unacked: 2, groups: 2, levels: 0 });
  assert.deepEqual(st.unacked(sessionId).map((u) => u.seq), [1, 2]);
  assert.equal(st.recordSent(sessionId, key(1), 1, 71), false); // 대체 바이트가 상한을 넘으면 거부, 변화 없음
  assert.equal(st.stats(sessionId).retainedBytes, 60);
  assert.throws(() => st.recordSent(sessionId, key(3), 2, 1), RangeError); // 같은 seq 다른 key
  assert.throws(() => st.recordSent(sessionId, key(2), 1, 1), RangeError); // 같은 key 다른(낮은) seq
  // 재접속 뒤 재전송 후보였던 항목을 같은 seq 로 다시 기록하면 후보에서 빠진다
  st.open({ sessionId, lastPieceSeq: 0 });
  assert.equal(st.shouldSend(sessionId, key(2)), true);
  assert.equal(st.recordSent(sessionId, key(2), 2, 30), true);
  assert.equal(st.shouldSend(sessionId, key(2)), false);
  // 확인된 항목의 재기록은 아무것도 바꾸지 않는다
  st.ack(sessionId, 2);
  assert.equal(st.recordSent(sessionId, key(1), 1, 30), true);
  assert.deepEqual(st.stats(sessionId), { entries: 2, retainedBytes: 0, unacked: 0, groups: 2, levels: 0 });
  assert.equal(st.open({ sessionId, lastPieceSeq: 0 }).nextPieceSeq, 3);
});

// ---- F-203 ②: u32 끝 ----
test('F-203: recordSent(0xFFFFFFFF) 뒤 재접속은 nextPieceSeq 2^32 를 내지 않고 새 세션', () => {
  const welcome = (r) => decodeMessage(encodeMessage({ type: 'WELCOME', sessionId: r.sessionId, resumed: r.resumed, nextPieceSeq: r.nextPieceSeq }));
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.equal(st.recordSent(sessionId, key(1), 0xfffffffe, 1), true);
  const r1 = st.open({ sessionId, lastPieceSeq: 0 });
  assert.deepEqual([r1.resumed, r1.nextPieceSeq], [true, 0xffffffff]);
  assert.equal(welcome(r1).nextPieceSeq, 0xffffffff);
  assert.equal(st.recordSent(sessionId, key(2), 0xffffffff, 1), true); // 계약 범위의 마지막 순번
  assert.equal(st.recordSent(sessionId, key(2), 0xffffffff, 1), true); // 멱등 재기록도 된다
  assert.throws(() => st.recordSent(sessionId, key(3), 2 ** 32, 1), RangeError);
  st.ack(sessionId, 0xffffffff);
  assert.equal(st.unacked(sessionId).length, 0);
  const r2 = st.open({ sessionId, lastPieceSeq: 0xffffffff });
  assert.deepEqual([r2.resumed, r2.reason, r2.nextPieceSeq], [false, 'UNKNOWN_SESSION', PIECE_SEQ_MIN]);
  assert.notEqual(r2.sessionId, sessionId);
  assert.deepEqual(welcome(r2), { type: 'WELCOME', sessionId: r2.sessionId, resumed: false, nextPieceSeq: 1 });
  assert.equal(st.open({ sessionId, lastPieceSeq: 0 }).resumed, false); // 다 쓴 세션은 지워졌다
});

// ---- F-207 / F-209 ⑦ ----
test('F-207a: 같은 key 를 새 seq 로 대체한 뒤 축출해도 groups 는 항목 상한을 넘지 않는다', () => {
  const { st } = mk({ maxEntriesPerSession: 2 });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  st.recordSent(sessionId, key(1), 1, 1);
  st.recordSent(sessionId, key(1), 2, 1); // 대체: 묶음 항목 수는 그대로 1
  st.recordSent(sessionId, key(2), 3, 1);
  st.ack(sessionId, 3);
  assert.deepEqual(st.stats(sessionId), { entries: 2, retainedBytes: 0, unacked: 0, groups: 2, levels: 0 });
  assert.equal(st.recordSent(sessionId, key(3), 4, 1), true); // key(1)(seq 2) 축출 -> 그 묶음도 사라져야 한다
  const stt = st.stats(sessionId);
  assert.ok(stt.groups <= 2, `groups=${stt.groups}`);
  assert.deepEqual(stt, { entries: 2, retainedBytes: 1, unacked: 1, groups: 2, levels: 0 });
});

test('F-207b: 같은 seq 를 다른 크기로 다시 기록하면 retainedBytes 가 손으로 센 값이고 ack 후 0', () => {
  const { st } = mk();
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  st.recordSent(sessionId, key(1), 1, 10);
  st.recordSent(sessionId, key(2), 2, 5);
  assert.equal(st.stats(sessionId).retainedBytes, 15);
  assert.equal(st.recordSent(sessionId, key(1), 1, 30), true); // 10 -> 30
  assert.equal(st.stats(sessionId).retainedBytes, 35);
  assert.equal(st.recordSent(sessionId, key(1), 1, 4), true); // 30 -> 4
  assert.equal(st.stats(sessionId).retainedBytes, 9);
  assert.equal(st.retainedBytes(), 9);
  st.ack(sessionId, 1);
  assert.equal(st.stats(sessionId).retainedBytes, 5);
  st.ack(sessionId, 2);
  assert.equal(st.stats(sessionId).retainedBytes, 0);
  assert.equal(st.retainedBytes(), 0);
});

test('F-209 ⑦: ack 후 같은 key 재기록 100만 번 뒤에도 ackedQ <= maxEntries 이고 빠르다', () => {
  const maxEntries = 4;
  const { st } = mk({ maxEntriesPerSession: maxEntries });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  for (let i = 1; i <= 3; i++) { st.recordSent(sessionId, key(i), i, 1); st.ack(sessionId, i); }
  const c0 = process.cpuUsage(); // 벽시계는 병렬 부하에 흔들리므로 CPU 시간으로 잰다
  let seq = 4;
  for (let n = 0; n < 1_000_000; n++) {
    st.recordSent(sessionId, key(1), seq, 1);
    st.ack(sessionId, seq++);
  }
  const c1 = process.cpuUsage(c0);
  const ms = (c1.user + c1.system) / 1000;
  assert.ok(st.ackedQueueLength(sessionId) <= maxEntries, `ackedQ=${st.ackedQueueLength(sessionId)}`);
  assert.equal(st.ackedQueueLength(sessionId), 3);
  assert.deepEqual(st.stats(sessionId), { entries: 3, retainedBytes: 0, unacked: 0, groups: 3, levels: 0 });
  console.log(`# cpu ms = ${ms}`); // 시간 단정 없음(로그만)
  // 가득 찬 뒤에도 가장 오래 확인된 항목부터 축출된다
  st.recordSent(sessionId, key(9), seq++, 1);
  assert.equal(st.recordSent(sessionId, key(10), seq++, 1), true);
  assert.equal(st.stats(sessionId).entries, 4);
});

// ---- F-212 ①: 음성 테스트(변이를 잡는다) ----
test('F-212: 모르는·닫힌 세션은 shouldSend/recordSent/ack/unacked 가 모두 거부', () => {
  const { st } = mk();
  assert.equal(st.shouldSend(4242, key(1)), false); // 모르는 세션: true 를 돌려주면 안 된다
  assert.equal(st.recordSent(4242, key(1), 1, 1), false);
  assert.deepEqual(st.unacked(4242), []);
  assert.equal(st.stats(4242), null);
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.equal(st.shouldSend(sessionId, key(1)), true);
  st.close(sessionId);
  assert.equal(st.shouldSend(sessionId, key(1)), false);
  assert.equal(st.recordSent(sessionId, key(1), 1, 1), false);
  assert.equal(st.stats(sessionId), null);
  assert.equal(st.size(), 0);
});

test('F-212: TTL 경계 — 경과 ttl-1 은 살아 있고 ttl 은 만료(shouldSend·recordSent·ack·stats 모두)', () => {
  const ttl = 1000;
  const probes = {
    shouldSend: (st, id) => st.shouldSend(id, key(9)),
    recordSent: (st, id) => st.recordSent(id, key(9), 2, 1),
    stats: (st, id) => st.stats(id) !== null,
    unacked: (st, id) => st.unacked(id).length === 1,
  };
  for (const [name, probe] of Object.entries(probes)) {
    for (const [dt, alive] of [[ttl - 1, true], [ttl, false], [ttl + 1, false]]) {
      const { c, st } = mk({ ttlMs: ttl });
      const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
      st.recordSent(sessionId, key(1), 1, 1);
      c.t += dt;
      assert.equal(probe(st, sessionId), alive, `${name} dt=${dt}`);
    }
  }
  // 만료된 세션은 ack 해도 되살아나지 않는다
  const { c, st } = mk({ ttlMs: ttl });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  c.t += ttl;
  st.ack(sessionId, 0);
  assert.equal(st.stats(sessionId), null);
  assert.equal(st.open({ sessionId, lastPieceSeq: 0 }).resumed, false);
});

test('F-212: TTL 갱신은 open 뿐 아니라 recordSent(새 기록·멱등 재기록)·ack 로도 된다', () => {
  const ttl = 1000;
  const steps = {
    recordNew: (st, id, n) => st.recordSent(id, key(100 + n), 2 + n, 1),
    recordIdempotent: (st, id) => st.recordSent(id, key(1), 1, 1),
    ack: (st, id) => st.ack(id, 0),
  };
  for (const [name, step] of Object.entries(steps)) {
    const { c, st } = mk({ ttlMs: ttl });
    const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
    st.recordSent(sessionId, key(1), 1, 1);
    for (let n = 0; n < 5; n++) { // 매번 ttl-1 만 흘려도 활동 때문에 계속 산다
      c.t += ttl - 1;
      assert.notEqual(st.stats(sessionId), null, `${name} #${n} 만료됨`);
      step(st, sessionId, n);
    }
    c.t += ttl - 1;
    assert.equal(st.shouldSend(sessionId, key(77)), true, name);
    c.t += 1; // 마지막 활동(shouldSend 는 갱신하지 않는다)이 아니라 step 이후 경과 (ttl-1)+1 = ttl → 만료
    assert.equal(st.stats(sessionId), null, name);
  }
  // 활동이 없으면 갱신도 없다: shouldSend/stats 는 TTL 을 늘리지 않는다
  const { c, st } = mk({ ttlMs: ttl });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  c.t += ttl - 1;
  st.shouldSend(sessionId, key(1));
  st.stats(sessionId);
  c.t += 1;
  assert.equal(st.stats(sessionId), null);
});

// ---- F-212 ⑥: 같은 key 대체가 pendingQ 에 죽은 항목을 쌓지 않는다 ----
test('F-212 ⑥: ack 없이 같은 key 100만 번 재기록해도 pendingQ <= 2×maxEntries 이고 빠르다', () => {
  const maxEntries = 8;
  const { st } = mk({ maxEntriesPerSession: maxEntries });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  const c0 = process.cpuUsage();
  let peak = 0;
  for (let seq = 1; seq <= 1_000_000; seq++) {
    assert.equal(st.recordSent(sessionId, key(1), seq, 1), true);
    if ((seq & 1023) === 0) peak = Math.max(peak, st.pendingQueueLength(sessionId));
  }
  const c1 = process.cpuUsage(c0);
  const ms = (c1.user + c1.system) / 1000;
  peak = Math.max(peak, st.pendingQueueLength(sessionId));
  assert.ok(peak <= 2 * maxEntries, `pendingQ=${peak}`);
  assert.deepEqual(st.stats(sessionId), { entries: 1, retainedBytes: 1, unacked: 1, groups: 1, levels: 0 });
  assert.deepEqual(st.unacked(sessionId), [{ seq: 1_000_000, key: key(1) }]);
  console.log(`# cpu ms = ${ms}`); // 시간 단정 없음(로그만)
  // 압축 뒤에도 ack·재접속 동작은 그대로
  st.ack(sessionId, 1_000_000);
  assert.deepEqual(st.stats(sessionId), { entries: 1, retainedBytes: 0, unacked: 0, groups: 1, levels: 0 });
  assert.equal(st.pendingQueueLength(sessionId), 0);
});

test('F-212 ⑥: 여러 key 가 섞여 대체돼도 순서·재전송 후보가 유지된다', () => {
  const { st } = mk({ maxEntriesPerSession: 8 });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  let seq = 1;
  for (let n = 0; n < 5000; n++) st.recordSent(sessionId, key(1 + (n % 3)), seq++, 1);
  assert.ok(st.pendingQueueLength(sessionId) <= 2 * 3, `pendingQ=${st.pendingQueueLength(sessionId)}`); // 살아 있는 3개 -> 길이 <= 2×3
  st.open({ sessionId, lastPieceSeq: 0 });
  assert.deepEqual(st.unacked(sessionId).map((u) => u.seq), [4998, 4999, 5000]);
  st.ack(sessionId, 4999);
  assert.deepEqual(st.unacked(sessionId).map((u) => u.seq), [5000]);
});

// ---- F-213: 상한에 닿은 뒤 '가장 오래된 것 축출'이 상한 크기에 비례해 느려지지 않는다 ----
// 다른 시험이 남긴 JIT·힙 상태에 휘둘리지 않도록 새 프로세스에서 잰다. 각 상한을 번갈아 7회씩 재 중앙값을 견준다(채우는 시간은 제외).
const EVICTION_BENCH = `
import { createSessionStore } from ${JSON.stringify(new URL('./index.mjs', import.meta.url).href)};
const kind = process.argv[1], ops = Number(process.argv[2]);
const sessions = (cap) => {
  let n = 1;
  const st = createSessionStore({ maxSessions: cap, ttlMs: 1e12, now: () => 0, randomId: () => n++ });
  const step = () => st.open({ sessionId: 0, lastPieceSeq: 0 });
  return { fill: cap, step, done: () => { if (st.size() !== cap) throw new Error('size'); } };
};
const acked = (cap) => {
  const st = createSessionStore({ maxSessions: 2, ttlMs: 1e12, now: () => 0, maxEntriesPerSession: cap });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  let seq = 1;
  const step = () => {
    if (!st.recordSent(sessionId, { segmentId: 1, level: 0, lod: 0, chunkIndex: seq, tileX: 0, tileY: 0 }, seq, 1)) throw new Error('rejected');
    st.ack(sessionId, seq++);
  };
  return { fill: cap, step, done: () => { if (st.ackedQueueLength(sessionId) !== cap) throw new Error('len'); } };
};
const make = kind === 'sessions' ? sessions : acked;
const time = (cap, n) => {
  const b = make(cap);
  for (let i = 0; i < b.fill; i++) b.step();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) b.step();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  b.done();
  return ms;
};
time(1000, 20000); time(65536, 20000);
const all = { 1000: [], 65536: [] };
for (let r = 0; r < 7; r++) for (const cap of [65536, 1000]) all[cap].push(time(cap, ops));
const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
console.log(JSON.stringify({ 1000: med(all[1000]), 65536: med(all[65536]) }));
`;
function evictionRatio(kind, ops) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', EVICTION_BENCH, kind, String(ops)], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const best = JSON.parse(r.stdout);
  return { ratio: best[65536] / best[1000], best };
}

// 판정 시험(결정적): 구현이 스스로 올리는 카운터는 믿지 않는다. 축출 구간에서 Map 의 반복 진입점(keys/values/entries/[Symbol.iterator]/forEach)을
// 밖에서 감싸 큰 Map(크기 >= SPY_MIN)에 대한 반복자 생성과 next() 호출을 센다. V8 Map 의 keys().next() 는 앞쪽 빈자리를 안에서 건너뛰어
// 상한에 비례해 느려지므로(R1/R2), 큰 Map 반복은 축출 경로에서 한 번도 없어야 하고 next() 호출도 축출 1회당 상수 이하여야 한다.
const SPY_MIN = 1024;
function spyMapIteration(fn) {
  // NOTE: This spy catches only prototype method lookups at call time by wrapping Map.prototype methods.
  // It cannot detect mutations that capture methods at module load time (e.g., const keys = Map.prototype.keys; keys.call(map)).
  // Methods bound or captured before spyMapIteration() runs will not be intercepted.
  const P = Map.prototype;
  const orig = { keys: P.keys, values: P.values, entries: P.entries, iter: P[Symbol.iterator], forEach: P.forEach };
  const c = { creates: 0, nexts: 0, forEachCalls: 0 };
  const wrap = (f) => function (...a) {
    const it = f.apply(this, a);
    if (this.size < SPY_MIN) return it;
    c.creates++;
    const next = it.next;
    it.next = function (...b) { c.nexts++; return next.apply(this, b); };
    return it;
  };
  P.keys = wrap(orig.keys); P.values = wrap(orig.values); P.entries = wrap(orig.entries); P[Symbol.iterator] = wrap(orig.iter);
  P.forEach = function (...a) { if (this.size >= SPY_MIN) c.forEachCalls++; return orig.forEach.apply(this, a); };
  try { fn(); } finally {
    P.keys = orig.keys; P.values = orig.values; P.entries = orig.entries; P[Symbol.iterator] = orig.iter; P.forEach = orig.forEach;
  }
  return c;
}
const EVICTIONS = 250_000;
const MAX_NEXTS_PER_EVICTION = 4;

test('F-213: 상한 65536 에서 25만 회 대체해도 세션 축출은 큰 Map 반복 없이 O(1)', () => {
  const cap = 65536;
  let n = 1;
  const st = createSessionStore({ maxSessions: cap, ttlMs: 1e12, now: () => 0, randomId: () => n++ });
  for (let i = 0; i < cap; i++) st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.equal(st.size(), cap);
  const c = spyMapIteration(() => {
    for (let i = 0; i < EVICTIONS; i++) st.open({ sessionId: 0, lastPieceSeq: 0 });
  });
  assert.equal(st.size(), cap);
  assert.equal(c.creates, 0, `큰 Map 반복자 생성 ${c.creates}회`);
  assert.equal(c.forEachCalls, 0);
  assert.ok(c.nexts <= MAX_NEXTS_PER_EVICTION * EVICTIONS, `next/eviction = ${c.nexts / EVICTIONS}`);
});

test('F-213: 상한 65536 에서 25만 회 대체해도 ackedQ 축출은 큰 Map 반복 없이 O(1)', () => {
  const cap = 65536;
  const st = createSessionStore({ maxSessions: 2, ttlMs: 1e12, now: () => 0, maxEntriesPerSession: cap });
  const { sessionId } = st.open({ sessionId: 0, lastPieceSeq: 0 });
  const rec = (seq) => {
    assert.ok(st.recordSent(sessionId, { segmentId: 1, level: 0, lod: 0, chunkIndex: seq, tileX: 0, tileY: 0 }, seq, 1));
    st.ack(sessionId, seq);
  };
  for (let seq = 1; seq <= cap; seq++) rec(seq);
  assert.equal(st.ackedQueueLength(sessionId), cap);
  const c = spyMapIteration(() => {
    for (let seq = cap + 1; seq <= cap + EVICTIONS; seq++) rec(seq);
  });
  assert.equal(st.ackedQueueLength(sessionId), cap);
  assert.equal(c.creates, 0, `큰 Map 반복자 생성 ${c.creates}회`);
  assert.equal(c.forEachCalls, 0);
  assert.ok(c.nexts <= MAX_NEXTS_PER_EVICTION * EVICTIONS, `next/eviction = ${c.nexts / EVICTIONS}`);
});

// 보조 측정(판정 아님): 벽시계 비율을 로그로만 남긴다. 장비·GC 에 따라 흔들리므로 판정에는 쓰지 않는다(시계 단정 없음).
for (const [kind, label] of [['sessions', 'session cap'], ['acked', 'ackedQ']]) {
  test(`F-213 (보조 측정): ${label} 축출 벽시계 비율 cap65536/cap1000 을 로그로 남긴다`, () => {
    const { ratio, best } = evictionRatio(kind, 250_000);
    console.log(`# F-213 ${label} wall-clock ratio cap65536/cap1000 = ${ratio.toFixed(2)} ${JSON.stringify(best)}`);
  });
}

test('F-213: 오래된 순서 축출은 최근 사용(touch) 순서와 ackedQ 확인 순서를 지킨다', () => {
  const { c, st } = mk({ maxSessions: 3 });
  const a = st.open({ sessionId: 0, lastPieceSeq: 0 }).sessionId;
  const b = st.open({ sessionId: 0, lastPieceSeq: 0 }).sessionId;
  const d = st.open({ sessionId: 0, lastPieceSeq: 0 }).sessionId;
  c.t += 1;
  st.ack(a, 0); // a 를 최근으로
  st.open({ sessionId: 0, lastPieceSeq: 0 }); // b 가 축출된다
  assert.equal(st.stats(b), null);
  assert.notEqual(st.stats(a), null);
  assert.notEqual(st.stats(d), null);
  const { st: s2 } = mk({ maxEntriesPerSession: 3 });
  const id = s2.open({ sessionId: 0, lastPieceSeq: 0 }).sessionId;
  for (let i = 1; i <= 3; i++) s2.recordSent(id, key(i), i, 1);
  s2.ack(id, 3);
  for (let i = 4; i <= 9; i++) { s2.recordSent(id, key(i), i, 1); s2.ack(id, i); }
  assert.equal(s2.shouldSend(id, key(9)), false);
  assert.equal(s2.stats(id).entries, 3);
});
