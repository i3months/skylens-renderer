// 재전송 정지 정책 시험(F-275 정책 (a)) + F-277 ①·②.
//   (1) 감독 재현: 첫 연결 seq1·2 + LA(seg9 1..2) → 끊김 → seq2 바이트 없음 → HELLO{lastPieceSeq:0}
//       → WELCOME·PIECE1·ERROR(UNAVAILABLE) 송출, close(1011), onSession·makeEmit 0회, emit 던짐,
//       firstPieceSeq=3 어댑터는 아무것도 보내지 못하고 저장소 resendPlan 은 그대로 남는다.
//   (2) 정지가 없으면 기존처럼 onSession 이 불리고 emit 이 동작한다.
//   (3) F-277 ①: 비동기 replay 가 끝나기 전에 접속이 닫히면 makeEmit·onSession 0회.
//   (4) F-277 ②: HELLO 뒤 복호 불가 메시지는 ERROR(BAD_MESSAGE) + close(1002).
// 벽시계 대기 없음: 지연은 시험이 직접 푸는 promise 로만 흉내 낸다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachConnection } from './connection.mjs';
import { createRecordingEmit } from './emit.mjs';
import { createSessionStore } from '../resume/index.mjs';
import { createCoreAdapter } from '../../adapter/core/index.mjs';
import { encodeMessage as clientEncode, decodeMessage as clientDecode } from '../../../client/proto/index.mjs';
import { decodeMessage as serverDecode } from '../../proto/codec/index.mjs';
import { pieceKeyString } from '../../../contracts/proto/index.mjs';

// ── 기준값 ───────────────────────────────────────────────────────────
const SEG_A = 9; // 첫 연결이 보낸 구간
const SEG_B = 10; // 이어받기 뒤 어댑터가 보내려는 구간
const LEVEL = 1;
const MISSING_SEQ = 2; // 바이트를 잃은 순번
const NEW_ADAPTER_FIRST_SEQ = 3; // 이어받기 뒤 새 어댑터의 firstPieceSeq
const ERR_UNAVAILABLE = 5;
const ERR_BAD_MESSAGE = 1;
const CLOSE_INTERNAL = 1011;
const CLOSE_PROTOCOL = 1002;

function fakeConn() {
  const c = { sent: [], closes: [], msgCb: null, closeCb: null };
  c.send = (b) => { c.sent.push(b); return true; };
  c.onMessage = (cb) => { c.msgCb = cb; };
  c.onClose = (cb) => { c.closeCb = cb; };
  // 실제 접속처럼 close 하면 닫힘 알림이 온다.
  c.close = (code) => { c.closes.push(code); if (c.closeCb) c.closeCb({ code, reason: '' }); };
  c.bufferedAmount = () => 0;
  return c;
}
const pieces = (segmentId, n) => Array.from({ length: n }, (_, i) => ({
  key: { segmentId, level: LEVEL, lod: 0, chunkIndex: i, tileX: 0, tileY: 0 },
  bytes: Uint8Array.from({ length: 4 + i }, (_, j) => (segmentId * 13 + i * 5 + j) & 0xff),
}));
const decodedTypes = (conn) => conn.sent.map((b) => clientDecode(b));

/** 실제 저장소·emit·replay·코덱으로 attachConnection 을 배선하고 호출 횟수를 센다. */
function wire({ store, loadPiece }) {
  const conn = fakeConn();
  const counts = { onSession: 0, makeEmit: 0 };
  const api = attachConnection({
    conn, store, loadPiece,
    onSession: () => { counts.onSession += 1; },
    makeEmit: (o) => { counts.makeEmit += 1; return createRecordingEmit(o); },
  });
  return { conn, counts, api };
}

test('(1) 감독 재현: 재전송 정지면 ERROR(5)·close(1011), 생방송 불가, resendPlan 보존', async () => {
  const store = createSessionStore({ maxSessions: 4, ttlMs: 60_000, now: () => 0 });
  const segA = pieces(SEG_A, 2);
  const bytesByKey = new Map(segA.map((p) => [pieceKeyString(p.key), p.bytes]));
  let lost = false;
  const loadPiece = (key) => {
    const ks = pieceKeyString(key);
    if (lost && ks === pieceKeyString(segA[MISSING_SEQ - 1].key)) return null;
    return bytesByKey.get(ks) ?? null;
  };

  // 첫 연결: 새 세션, seq1·2 + LA(seg9 1..2).
  const w1 = wire({ store, loadPiece });
  await w1.conn.msgCb(clientEncode({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 }));
  assert.equal(w1.counts.onSession, 1);
  const sid = w1.api.sessionId();
  const a1 = createCoreAdapter({ emit: (m) => w1.api.emit(m) });
  assert.equal(a1.handle({ kind: 'level_arrived', segmentId: SEG_A, level: LEVEL, pieces: segA }).action, 'first');
  assert.deepEqual(decodedTypes(w1.conn).map((m) => m.type), ['WELCOME', 'PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  const planBefore = store.resendPlan(sid);
  assert.equal(planBefore.length, 3);

  // 끊김 → seq2 바이트 소실 → HELLO{sid, lastPieceSeq:0}.
  w1.conn.closeCb({ code: 1006, reason: '' });
  lost = true;
  const w2 = wire({ store, loadPiece });
  await w2.conn.msgCb(clientEncode({ type: 'HELLO', sessionId: sid, lastPieceSeq: 0 }));

  const got = decodedTypes(w2.conn);
  assert.deepEqual(got.map((m) => m.type), ['WELCOME', 'PIECE', 'ERROR']);
  assert.equal(got[0].resumed, true);
  assert.equal(got[1].pieceSeq, 1);
  assert.equal(got.filter((m) => m.type === 'ERROR').length, 1);
  assert.equal(got[2].code, ERR_UNAVAILABLE);
  assert.deepEqual(w2.conn.closes, [CLOSE_INTERNAL]);
  assert.equal(w2.counts.onSession, 0);
  assert.equal(w2.counts.makeEmit, 0);
  assert.throws(() => w2.api.emit({ type: 'MISSING', segmentId: SEG_B }));

  // firstPieceSeq=3 어댑터는 아무것도 보내지 못한다(emit 이 던진다).
  const a2 = createCoreAdapter({ emit: (m) => w2.api.emit(m), firstPieceSeq: NEW_ADAPTER_FIRST_SEQ });
  assert.throws(() => a2.handle({ kind: 'level_arrived', segmentId: SEG_B, level: LEVEL, pieces: pieces(SEG_B, 1) }));
  assert.equal(w2.conn.sent.length, 3);

  // 닫힌 접속의 ACK(3) 는 처리되지 않는다.
  await w2.conn.msgCb(clientEncode({ type: 'ACK', upToPieceSeq: NEW_ADAPTER_FIRST_SEQ }));

  const plan = store.resendPlan(sid);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((m) => m.type), ['PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  assert.equal(plan[1].pieceSeq, MISSING_SEQ);
  assert.equal(plan[1].key.segmentId, SEG_A);
  assert.deepEqual(
    { segmentId: plan[2].segmentId, firstPieceSeq: plan[2].firstPieceSeq, pieceCount: plan[2].pieceCount },
    { segmentId: SEG_A, firstPieceSeq: 1, pieceCount: 2 },
  );
  assert.equal(plan.some((m) => m.segmentId === SEG_B || m.key?.segmentId === SEG_B), false);
  // 세션은 저장소에서 지우지 않는다.
  assert.equal(store.size(), 1);
});

test('(2) 정지 없음(stoppedAt === null): onSession 1회, emit 동작', async () => {
  const store = createSessionStore({ maxSessions: 4, ttlMs: 60_000, now: () => 0 });
  const segA = pieces(SEG_A, 2);
  const bytesByKey = new Map(segA.map((p) => [pieceKeyString(p.key), p.bytes]));
  const loadPiece = (key) => bytesByKey.get(pieceKeyString(key)) ?? null;
  const w1 = wire({ store, loadPiece });
  await w1.conn.msgCb(clientEncode({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 }));
  const sid = w1.api.sessionId();
  createCoreAdapter({ emit: (m) => w1.api.emit(m) }).handle({ kind: 'level_arrived', segmentId: SEG_A, level: LEVEL, pieces: segA });
  w1.conn.closeCb({ code: 1006, reason: '' });

  const w2 = wire({ store, loadPiece });
  await w2.conn.msgCb(clientEncode({ type: 'HELLO', sessionId: sid, lastPieceSeq: 0 }));
  assert.deepEqual(decodedTypes(w2.conn).map((m) => m.type), ['WELCOME', 'PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  assert.equal(w2.counts.onSession, 1);
  assert.equal(w2.counts.makeEmit, 1);
  assert.deepEqual(w2.conn.closes, []);
  const a2 = createCoreAdapter({ emit: (m) => w2.api.emit(m), firstPieceSeq: NEW_ADAPTER_FIRST_SEQ });
  assert.equal(a2.handle({ kind: 'level_arrived', segmentId: SEG_B, level: LEVEL, pieces: pieces(SEG_B, 1) }).action, 'first');
  const after = decodedTypes(w2.conn).slice(4);
  assert.deepEqual(after.map((m) => m.type), ['PIECE', 'LEVEL_ARRIVED']);
  assert.equal(after[0].pieceSeq, NEW_ADAPTER_FIRST_SEQ);
});

test('(3) F-277 ①: replay 지연 중 접속이 닫히면 makeEmit·onSession 0회', async () => {
  const conn = fakeConn();
  let release;
  const gate = new Promise((r) => { release = r; });
  const counts = { onSession: 0, makeEmit: 0 };
  const api = attachConnection({
    conn, store: { ack() {} }, loadPiece: () => null,
    replay: async () => { await gate; return { sessionId: 7, resumed: false, nextPieceSeq: 1, stoppedAt: null }; },
    makeEmit: () => { counts.makeEmit += 1; return () => {}; },
    onSession: () => { counts.onSession += 1; },
  });
  const done = conn.msgCb(clientEncode({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 }));
  conn.closeCb({ code: 1006, reason: '' }); // replay 가 끝나기 전에 닫힘
  release();
  await done;
  assert.equal(counts.makeEmit, 0);
  assert.equal(counts.onSession, 0);
  assert.equal(conn.sent.length, 0);
  assert.throws(() => api.emit({ type: 'MISSING', segmentId: 1 }));
});

// 실제 코덱은 짧은 바이트에 던진다. null 경우는 첫 호출(HELLO)만 실제 코덱으로 복호하고 그 뒤는 null 을 돌려준다.
for (const [label, makeDecode] of [
  ['복호가 던짐', () => serverDecode],
  ['복호 결과 null', () => { let n = 0; return (b) => (n++ === 0 ? serverDecode(b) : null); }],
]) {
  test(`(4) F-277 ②: HELLO 뒤 ${label} → ERROR(BAD_MESSAGE) + close(1002)`, async () => {
    const conn = fakeConn();
    const sessions = [];
    attachConnection({
      conn, store: { ack() {} }, loadPiece: () => null,
      decode: makeDecode(),
      replay: async () => ({ sessionId: 7, resumed: false, nextPieceSeq: 1, stoppedAt: null }),
      makeEmit: () => () => {},
      onSession: (id) => sessions.push(id),
    });
    await conn.msgCb(clientEncode({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 }));
    assert.deepEqual(sessions, [7]);
    await conn.msgCb(new Uint8Array([1, 2, 3]));
    assert.equal(conn.sent.length, 1);
    const err = clientDecode(conn.sent[0]);
    assert.equal(err.type, 'ERROR');
    assert.equal(err.code, ERR_BAD_MESSAGE);
    assert.deepEqual(conn.closes, [CLOSE_PROTOCOL]);
  });
}
