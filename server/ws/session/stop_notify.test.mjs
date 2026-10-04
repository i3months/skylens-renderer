// 재전송 정지 알림 시험(F-279).
//   시나리오: ttl 1000ms, 첫 연결이 seq1·2 + LA(seg9 1..2) 를 보낸 뒤 끊김, seq2 바이트 소실,
//   900ms 간격으로 같은 sid 의 HELLO{sid, lastPieceSeq:0} 를 반복한다.
//   (A) 기준: onStopped 를 쓰지 않으면 open 이 TTL 을 갱신해 세션이 만료되지 않고 매번 같은 정지가 반복된다.
//   (B) 호출자가 onStopped 에서 store.close 하면 첫 정지에서 sessionId·stoppedAt 을 받고 세션이 닫히며,
//       다음 같은 sid HELLO 는 resumed:false·reason UNKNOWN_SESSION 이 된다.
//   (E) replay 중 접속이 닫힌 뒤 replay 가 정지를 보고해도 onStopped 를 부른다(onSession 은 안 부름, ERROR·close 없음).
//   (C) 정지 1011 은 사유 'replay-stopped', 그 밖의 1011 은 'internal-error' 로 구별된다.
// 시계는 주입(now)만 쓴다. 벽시계 대기 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachConnection, CLOSE_REASON_REPLAY_STOPPED, CLOSE_REASON_INTERNAL } from './connection.mjs';
import { replayAfterHello } from './resume.mjs';
import { createSessionStore } from '../resume/index.mjs';
import { createCoreAdapter } from '../../adapter/core/index.mjs';
import { encodeMessage as clientEncode, decodeMessage as clientDecode } from '../../../client/proto/index.mjs';
import { pieceKeyString } from '../../../contracts/proto/index.mjs';

// ── 기준값 ───────────────────────────────────────────────────────────
const TTL_MS = 1000;
const HELLO_INTERVAL_MS = 900; // TTL 보다 짧다
const REPEATS = 5; // 끊긴 뒤 같은 sid HELLO 횟수
const SEG = 9;
const LEVEL = 1;
const MISSING_SEQ = 2; // 바이트를 잃은 순번
const ERR_UNAVAILABLE = 5;
const CLOSE_INTERNAL = 1011;

function fakeConn() {
  const c = { sent: [], closes: [], msgCb: null, closeCb: null };
  c.send = (b) => { c.sent.push(b); return true; };
  c.onMessage = (cb) => { c.msgCb = cb; };
  c.onClose = (cb) => { c.closeCb = cb; };
  c.close = (code, reason = '') => { c.closes.push({ code, reason }); if (c.closeCb) c.closeCb({ code, reason }); };
  c.bufferedAmount = () => 0;
  return c;
}
const pieces = (segmentId, n) => Array.from({ length: n }, (_, i) => ({
  key: { segmentId, level: LEVEL, lod: 0, chunkIndex: i, tileX: 0, tileY: 0 },
  bytes: Uint8Array.from({ length: 4 + i }, (_, j) => (segmentId * 13 + i * 5 + j) & 0xff),
}));

/** 첫 연결로 seq1·2 + LA 를 보내고 끊은 뒤, seq2 바이트를 잃은 상태를 만든다. */
async function setup() {
  let t = 0;
  const store = createSessionStore({ maxSessions: 4, ttlMs: TTL_MS, now: () => t });
  const seg = pieces(SEG, 2);
  const bytesByKey = new Map(seg.map((p) => [pieceKeyString(p.key), p.bytes]));
  const lostKey = pieceKeyString(seg[MISSING_SEQ - 1].key);
  let lost = false;
  const loadPiece = (key) => {
    const ks = pieceKeyString(key);
    if (lost && ks === lostKey) return null;
    return bytesByKey.get(ks) ?? null;
  };
  const c1 = fakeConn();
  const api1 = attachConnection({ conn: c1, store, loadPiece });
  await c1.msgCb(clientEncode({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 }));
  const sid = api1.sessionId();
  createCoreAdapter({ emit: (m) => api1.emit(m) }).handle({ kind: 'level_arrived', segmentId: SEG, level: LEVEL, pieces: seg });
  c1.closeCb({ code: 1006, reason: '' });
  lost = true;
  return { store, loadPiece, sid, advance: (ms) => { t += ms; } };
}

/** 같은 sid 로 HELLO 하는 접속 하나. replay 결과(reason 포함)를 잡는다. */
async function helloOnce({ store, loadPiece, sid, onStopped }) {
  const conn = fakeConn();
  const results = [];
  const stops = [];
  const api = attachConnection({
    conn, store, loadPiece,
    replay: (o) => { const r = replayAfterHello(o); results.push(r); return r; },
    onStopped: (id, info) => { stops.push([id, info]); if (onStopped) onStopped(id, info); },
  });
  await conn.msgCb(clientEncode({ type: 'HELLO', sessionId: sid, lastPieceSeq: 0 }));
  return { conn, api, result: results[0], stops, msgs: conn.sent.map((b) => clientDecode(b)) };
}

test('(A) 기준: 알림을 무시하면 900ms 간격 HELLO 5회 모두 이어받기·정지(TTL 1000 이 만료시키지 못함)', async () => {
  const env = await setup();
  const stoppedAts = [];
  for (let i = 0; i < REPEATS; i++) {
    env.advance(HELLO_INTERVAL_MS);
    const h = await helloOnce(env);
    assert.equal(h.result.resumed, true);
    assert.equal(h.result.reason, null);
    assert.equal(h.result.sessionId, env.sid);
    stoppedAts.push(h.result.stoppedAt);
    assert.deepEqual(h.stops, [[env.sid, { stoppedAt: MISSING_SEQ }]]);
    assert.deepEqual(h.conn.closes, [{ code: CLOSE_INTERNAL, reason: CLOSE_REASON_REPLAY_STOPPED }]);
  }
  assert.deepEqual(stoppedAts, Array(REPEATS).fill(MISSING_SEQ));
  assert.equal(env.store.size(), 1);
});

test('(B) onStopped 에서 store.close: 첫 정지에 sid·stoppedAt 을 받고, 다음 같은 sid HELLO 는 UNKNOWN_SESSION', async () => {
  const env = await setup();
  const closeSession = (id) => env.store.close(id);

  env.advance(HELLO_INTERVAL_MS);
  const first = await helloOnce({ ...env, onStopped: closeSession });
  const types = first.msgs.map((m) => m.type);
  assert.deepEqual(types, ['WELCOME', 'PIECE', 'ERROR']);
  assert.equal(first.msgs[0].resumed, true);
  assert.equal(first.msgs[1].pieceSeq, MISSING_SEQ - 1);
  assert.equal(first.msgs[2].code, ERR_UNAVAILABLE);
  assert.deepEqual(first.conn.closes, [{ code: CLOSE_INTERNAL, reason: CLOSE_REASON_REPLAY_STOPPED }]);
  assert.deepEqual(first.stops, [[env.sid, { stoppedAt: MISSING_SEQ }]]);
  // 정지 뒤에도 sessionId() 는 값을 돌려준다. emit 은 여전히 던진다.
  assert.equal(first.api.sessionId(), env.sid);
  assert.throws(() => first.api.emit({ type: 'MISSING', segmentId: SEG }));
  assert.equal(env.store.size(), 0);

  env.advance(HELLO_INTERVAL_MS);
  const second = await helloOnce({ ...env, onStopped: closeSession });
  assert.equal(second.result.resumed, false);
  assert.equal(second.result.reason, 'UNKNOWN_SESSION');
  assert.notEqual(second.result.sessionId, env.sid);
  assert.equal(second.result.stoppedAt, null);
  assert.deepEqual(second.msgs.map((m) => m.type), ['WELCOME']);
  assert.equal(second.msgs[0].resumed, false);
  assert.deepEqual(second.stops, []);
  assert.deepEqual(second.conn.closes, []);
});

test('(C) 정지 아닌 1011 은 사유 internal-error, onStopped 0회', async () => {
  const conn = fakeConn();
  const stops = [];
  attachConnection({
    conn, store: { ack() {} }, loadPiece: () => null,
    replay: async () => { throw new Error('실패'); },
    onStopped: (id, info) => stops.push([id, info]),
  });
  await conn.msgCb(clientEncode({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 }));
  assert.deepEqual(conn.closes, [{ code: CLOSE_INTERNAL, reason: CLOSE_REASON_INTERNAL }]);
  assert.notEqual(CLOSE_REASON_INTERNAL, CLOSE_REASON_REPLAY_STOPPED);
  assert.deepEqual(stops, []);
});

test('(D) onStopped 가 던져도 정지 처리(ERROR·close 1회)는 그대로', async () => {
  const env = await setup();
  const h = await helloOnce({ ...env, onStopped: () => { throw new Error('알림 실패'); } });
  assert.deepEqual(h.msgs.map((m) => m.type), ['WELCOME', 'PIECE', 'ERROR']);
  assert.deepEqual(h.conn.closes, [{ code: CLOSE_INTERNAL, reason: CLOSE_REASON_REPLAY_STOPPED }]);
  assert.equal(h.stops.length, 1);
});

test('(E) replay 중 접속이 닫힌 뒤 replay 가 정지를 보고해도 onStopped 1회, onSession 0회, 추가 송신·close 없음', async () => {
  const conn = fakeConn();
  const stops = [];
  const sessions = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const api = attachConnection({
    conn, store: { ack() {} }, loadPiece: () => null,
    replay: async () => { await gate; return { sessionId: 77, resumed: true, nextPieceSeq: 3, stoppedAt: 2 }; },
    onSession: (id) => sessions.push(id),
    onStopped: (id, info) => stops.push([id, info]),
  });
  const pending = conn.msgCb(clientEncode({ type: 'HELLO', sessionId: 77, lastPieceSeq: 0 }));
  await new Promise((r) => setImmediate(r)); // handleHello 가 replay 를 기다리는 중이 되게 한다
  conn.closeCb({ code: 1011, reason: '' }); // 피어 close 에코: reason 이 비어 있다
  release();
  await pending;
  assert.deepEqual(stops, [[77, { stoppedAt: 2 }]]);
  assert.deepEqual(sessions, []);
  assert.deepEqual(conn.sent, []);
  assert.deepEqual(conn.closes, []);
  assert.equal(api.sessionId(), 77);
  assert.throws(() => api.emit({ type: 'MISSING', segmentId: SEG }));
});
