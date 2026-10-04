// F-270·F-274 시험: 이어받기 뒤 pieceSeq 하한(nextPieceSeq)과 닫는 중 emit 거부, 둘째 HELLO 거부.
// 실제 코어 어댑터(server/adapter/core) + 실제 이어받기 저장소(server/ws/resume) + attachConnection(가짜 접속 객체, 실제 코덱).
// 클라이언트 쪽은 client/proto 로 복호하고 contracts/client_raster 의 collectArrivals 로 완료 key 를 판정한다.
// 비동기는 conn.onMessage 콜백이 돌려주는 처리 사슬(Promise)만 기다린다(타이머 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachConnection } from './connection.mjs';
import { createRecordingEmit, SeqFloorError } from './emit.mjs';
import { createSessionStore } from '../resume/index.mjs';
import { createCoreAdapter } from '../../adapter/core/index.mjs';
import { encodeMessage as clientEncode, decodeMessage as clientDecode } from '../../../client/proto/index.mjs';
import { ERR_CODES, pieceKeyString } from '../../../contracts/proto/index.mjs';
import { collectArrivals, pieceKeyToString } from '../../../contracts/client_raster/arrival.mjs';

// ── 기준값 ───────────────────────────────────────────────────────────
const OLD_SEGMENT = 9; // 이어받기 전 연결이 보낸 구간(조각 seq 1·2, LEVEL_ARRIVED 1..2)
const NEW_SEGMENT = 10; // 이어받기 뒤 새 이벤트의 구간
const LEVEL = 1;
const LAST_PIECE_SEQ = 2; // HELLO 의 lastPieceSeq
const EXPECTED_NEXT_SEQ = 3; // WELCOME·onSession 의 nextPieceSeq
const EXPECTED_NEW_SEQS = [3, 4]; // 새 이벤트 PIECE 의 pieceSeq
const EXPECTED_STORED_DELTA = 1; // 새 LEVEL_ARRIVED 하나가 저장소에 보관된다
const EXPECTED_COMPLETED = 4; // 클라이언트 완료 key 수(옛 2 + 새 2)
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_INTERNAL_ERROR = 1011;

const piecesOf = (segmentId, n) => Array.from({ length: n }, (_, c) => ({
  key: { segmentId, level: LEVEL, lod: 0, chunkIndex: c, tileX: 0, tileY: 0 },
  bytes: Uint8Array.from({ length: 6 + c }, (_, i) => (segmentId * 13 + c * 5 + i) & 0xff),
}));
const OLD_PIECES = piecesOf(OLD_SEGMENT, 2);
const NEW_PIECES = piecesOf(NEW_SEGMENT, 2);

function fakeConn() {
  const c = { sent: [], closes: [], msgCb: null, closeCb: null };
  c.send = (b) => { c.sent.push(b); return true; };
  c.onMessage = (cb) => { c.msgCb = cb; };
  c.onClose = (cb) => { c.closeCb = cb; };
  c.close = (code) => { c.closes.push(code); };
  c.bufferedAmount = () => 0;
  c.decoded = () => c.sent.map((b) => clientDecode(b));
  c.deliver = (m) => c.msgCb(clientEncode(m)); // 처리 사슬이 끝날 때까지 기다릴 수 있다
  return c;
}

function newStore() {
  return createSessionStore({ maxSessions: 4, ttlMs: 60_000, now: () => 0 });
}

function makeLoader(pieces) {
  const m = new Map(pieces.map((p) => [pieceKeyString(p.key), p.bytes]));
  return (key) => m.get(pieceKeyString(key)) ?? null;
}

/** 감독 재현 상황: 첫 연결에서 seq 1·2 + LA(1..2) 송출 → 끊김 → HELLO{lastPieceSeq:2} 이어받기. */
async function resumedSetup() {
  const store = newStore();
  const loadPiece = makeLoader([...OLD_PIECES, ...NEW_PIECES]);

  const connA = fakeConn();
  const apiA = attachConnection({ conn: connA, store, loadPiece });
  await connA.deliver({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 });
  const adapterA = createCoreAdapter({ emit: (m) => apiA.emit(m) });
  assert.equal(adapterA.handle({ kind: 'level_arrived', segmentId: OLD_SEGMENT, level: LEVEL, pieces: OLD_PIECES }).action, 'first');
  const historyA = connA.decoded();
  assert.deepEqual(historyA.map((m) => m.type), ['WELCOME', 'PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  const sessionId = historyA[0].sessionId;
  connA.closeCb({ code: 1006, reason: '' });

  const connB = fakeConn();
  const sessions = [];
  const apiB = attachConnection({ conn: connB, store, loadPiece, onSession: (id, info) => sessions.push([id, info]) });
  await connB.deliver({ type: 'HELLO', sessionId, lastPieceSeq: LAST_PIECE_SEQ });
  return { store, sessionId, connB, apiB, sessions, historyA };
}

test('(1) 이어받기 뒤 onSession 이 nextPieceSeq 3 을 받고, firstPieceSeq=3 어댑터의 새 이벤트가 기록·복호·완료된다', async () => {
  const { store, sessionId, connB, apiB, sessions, historyA } = await resumedSetup();
  assert.deepEqual(sessions, [[sessionId, { resumed: true, nextPieceSeq: EXPECTED_NEXT_SEQ }]]);
  const welcome = connB.decoded()[0];
  assert.equal(welcome.type, 'WELCOME');
  assert.equal(welcome.nextPieceSeq, EXPECTED_NEXT_SEQ);

  const storedBefore = store.levelStats(sessionId).stored;
  const entriesBefore = store.stats(sessionId).entries;
  const sentBefore = connB.sent.length;
  const adapterB = createCoreAdapter({ emit: (m) => apiB.emit(m), firstPieceSeq: sessions[0][1].nextPieceSeq });
  assert.equal(adapterB.handle({ kind: 'level_arrived', segmentId: NEW_SEGMENT, level: LEVEL, pieces: NEW_PIECES }).action, 'first');

  const fresh = connB.decoded().slice(sentBefore);
  assert.deepEqual(fresh.map((m) => m.type), ['PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  assert.deepEqual(fresh.slice(0, 2).map((m) => m.pieceSeq), EXPECTED_NEW_SEQS);
  assert.equal(fresh[2].firstPieceSeq, EXPECTED_NEW_SEQS[0]);
  // 저장소에 기록됐다: PIECE 항목 2개, LEVEL_ARRIVED 보관 1개 증가.
  assert.equal(store.stats(sessionId).entries - entriesBefore, NEW_PIECES.length);
  assert.equal(store.levelStats(sessionId).stored - storedBefore, EXPECTED_STORED_DELTA);

  // 클라이언트 판정: 세션 수신 이력 전체.
  const { arrived } = collectArrivals([...historyA, ...connB.decoded()]);
  const completed = new Set(arrived.flatMap((a) => a.keys));
  assert.equal(completed.size, EXPECTED_COMPLETED);
  for (const p of [...OLD_PIECES, ...NEW_PIECES]) assert.ok(completed.has(pieceKeyToString(p.key)), pieceKeyToString(p.key));
});

test('(2) 하한 방어: 이어받기 뒤 pieceSeq 1·새 key PIECE 는 send 0회로 던진다', async () => {
  const { store, sessionId, connB, apiB } = await resumedSetup();
  const sentBefore = connB.sent.length;
  const entriesBefore = store.stats(sessionId).entries;
  const stray = { type: 'PIECE', pieceSeq: 1, key: NEW_PIECES[0].key, chunk: NEW_PIECES[0].bytes };
  assert.throws(() => apiB.emit(stray), (e) => e instanceof SeqFloorError && e.pieceSeq === 1 && e.floor === EXPECTED_NEXT_SEQ);
  assert.equal(connB.sent.length - sentBefore, 0);
  assert.equal(store.stats(sessionId).entries, entriesBefore);
  assert.deepEqual(connB.closes, []);
});

test('(3) 이 emit 이 보낸 같은 (seq,key) 재시도는 하한 미만이어도 통과, 다른 key 는 거부', () => {
  const store = newStore();
  const { sessionId } = store.open({ sessionId: 0, lastPieceSeq: 0 });
  let floor = 1;
  let failNext = true;
  const sent = [];
  const emit = createRecordingEmit({
    store, sessionId, minPieceSeq: () => floor,
    send: (b) => { if (failNext) { failNext = false; throw new Error('선 끊김'); } sent.push(b); },
  });
  const [a, b] = NEW_PIECES;
  const msgA = { type: 'PIECE', pieceSeq: 1, key: a.key, chunk: a.bytes };
  assert.throws(() => emit(msgA), /선 끊김/); // 기록됐고 선에 나갔는지는 모른다
  floor = EXPECTED_NEXT_SEQ; // 하한이 올라갔다
  emit(msgA); // 같은 (1, a) 재시도: 통과
  assert.equal(sent.length, 1);
  assert.deepEqual(clientDecode(sent[0]).key, a.key);
  assert.throws(() => emit({ type: 'PIECE', pieceSeq: 1, key: b.key, chunk: b.bytes }), SeqFloorError);
  assert.throws(() => emit({ type: 'PIECE', pieceSeq: 2, key: b.key, chunk: b.bytes }), SeqFloorError);
  assert.equal(sent.length, 1);
  // LEVEL_ARRIVED 가 나가면 그 창 이하 기록을 지운다: 그 뒤 같은 (1, a) 는 하한 미만 새 송출로 거부된다.
  emit({ type: 'LEVEL_ARRIVED', segmentId: NEW_SEGMENT, level: LEVEL, firstPieceSeq: 1, pieceCount: 1 });
  assert.equal(sent.length, 2);
  assert.throws(() => emit(msgA), SeqFloorError);
  assert.equal(sent.length, 2);
});

test('(3b) 정수 하한: 하한 미만 PIECE 는 이 emit 이 보낸 적 없으므로 거부, 하한 이상은 통과', () => {
  const store = newStore();
  const { sessionId } = store.open({ sessionId: 0, lastPieceSeq: 0 });
  const sent = [];
  const emit = createRecordingEmit({ store, sessionId, minPieceSeq: EXPECTED_NEXT_SEQ, send: (b) => sent.push(b) });
  const [a] = NEW_PIECES;
  assert.throws(() => emit({ type: 'PIECE', pieceSeq: 2, key: a.key, chunk: a.bytes }), SeqFloorError);
  assert.equal(sent.length, 0);
  emit({ type: 'PIECE', pieceSeq: EXPECTED_NEXT_SEQ, key: a.key, chunk: a.bytes });
  emit({ type: 'PIECE', pieceSeq: EXPECTED_NEXT_SEQ, key: a.key, chunk: a.bytes }); // 같은 (seq,key) 재시도(하한 이상)
  assert.equal(sent.length, 2);
  assert.throws(() => createRecordingEmit({ store, sessionId, minPieceSeq: 1.5, send: () => {} }), TypeError);
});

test('(4) onSession 이 던지면 close(1011) 1회, 그 뒤 api.emit 은 던지고 send 0회', async () => {
  const store = newStore();
  const conn = fakeConn();
  const api = attachConnection({
    conn, store, loadPiece: () => null, onSession: () => { throw new Error('onSession 실패'); },
  });
  await conn.deliver({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 });
  assert.deepEqual(conn.closes, [CLOSE_INTERNAL_ERROR]);
  const sentBefore = conn.sent.length; // WELCOME 1개
  assert.equal(sentBefore, 1);
  const [a] = NEW_PIECES;
  assert.throws(() => api.emit({ type: 'PIECE', pieceSeq: 1, key: a.key, chunk: a.bytes }));
  assert.throws(() => api.emit({ type: 'MISSING', segmentId: NEW_SEGMENT }));
  assert.equal(conn.sent.length - sentBefore, 0);
  assert.deepEqual(conn.closes, [CLOSE_INTERNAL_ERROR]);
});

test('(5) 둘째 HELLO 는 ERROR(BAD_MESSAGE) + close(1002) 로 거부', async () => {
  const store = newStore();
  const conn = fakeConn();
  const sessions = [];
  const api = attachConnection({ conn, store, loadPiece: () => null, onSession: (id, info) => sessions.push([id, info]) });
  await conn.deliver({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 });
  const sessionId = api.sessionId();
  await conn.deliver({ type: 'HELLO', sessionId, lastPieceSeq: 0 });
  const msgs = conn.decoded();
  assert.deepEqual(msgs.map((m) => m.type), ['WELCOME', 'ERROR']);
  assert.equal(msgs[1].code, ERR_CODES.BAD_MESSAGE);
  assert.deepEqual(conn.closes, [CLOSE_PROTOCOL_ERROR]);
  assert.equal(sessions.length, 1);
  // 닫는 중이므로 emit 도 거부한다.
  assert.throws(() => api.emit({ type: 'MISSING', segmentId: NEW_SEGMENT }));
  assert.equal(conn.sent.length, 2);
});
