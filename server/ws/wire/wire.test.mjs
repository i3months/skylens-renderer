// ws 진입점 배선 시험: onStopped 호출 수와 store.close 호출 수 계측(결정 0040 '다시 볼 조건').
// 정지 재현은 session/stop_notify.test.mjs 와 같다: 첫 연결이 seq1·2 + LEVEL_ARRIVED 를 보내고 끊긴 뒤 seq2 바이트가 사라진다.
import test from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createWire } from './index.mjs';
import { createWsServer } from '../index.mjs';
import { createSessionStore } from '../resume/index.mjs';
import { createCoreAdapter } from '../../adapter/core/index.mjs';
import { encodeMessage as clientEncode, decodeMessage as clientDecode } from '../../../client/proto/index.mjs';
import { pieceKeyString } from '../../../contracts/proto/index.mjs';

function loopbackHost() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.internal && a.family === 'IPv4') return a.address;
  }
  throw new Error('loopback 인터페이스 없음');
}

const SEG = 9;
const LEVEL = 1;
const MISSING_SEQ = 2;

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

/** wire 를 거쳐 첫 연결로 조각을 보내고 끊은 뒤, seq2 바이트를 잃는다. */
async function setup(wireOpts = {}) {
  const store = createSessionStore({ maxSessions: 4, ttlMs: 60000, now: () => 0 });
  const seg = pieces(SEG, 2);
  const bytesByKey = new Map(seg.map((p) => [pieceKeyString(p.key), p.bytes]));
  const lostKey = pieceKeyString(seg[MISSING_SEQ - 1].key);
  let lost = false;
  const loadPiece = (key) => {
    const ks = pieceKeyString(key);
    if (lost && ks === lostKey) return null;
    return bytesByKey.get(ks) ?? null;
  };
  const errors = [];
  const wire = createWire({ store, loadPiece, onError: (e, where) => errors.push(where), ...wireOpts });
  const c1 = fakeConn();
  const api1 = wire.onConnection(c1);
  await c1.msgCb(clientEncode({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 }));
  const sid = api1.sessionId();
  createCoreAdapter({ emit: (m) => api1.emit(m) }).handle({ kind: 'level_arrived', segmentId: SEG, level: LEVEL, pieces: seg });
  c1.closeCb({ code: 1006, reason: '' });
  lost = true;
  return { store, wire, sid, errors };
}
async function reconnect(env) {
  const conn = fakeConn();
  env.wire.onConnection(conn);
  await conn.msgCb(clientEncode({ type: 'HELLO', sessionId: env.sid, lastPieceSeq: 0 }));
  return conn;
}

test('정지가 나면 stoppedCalls === storeCloseCalls === 1 이고 세션이 닫힌다', async () => {
  const env = await setup();
  assert.deepEqual(env.wire.stats().stoppedCalls, 0);
  assert.equal(env.store.size(), 1);
  const conn = await reconnect(env);
  assert.deepEqual(conn.closes, [{ code: 1011, reason: 'replay-stopped' }]);
  const s = env.wire.stats();
  assert.equal(s.stoppedCalls, 1);
  assert.equal(s.storeCloseCalls, 1);
  assert.equal(env.store.size(), 0);
  assert.deepEqual(s.sameSidStops, { [env.sid]: 1 });
  // 다음 같은 sid HELLO 는 새 세션(정지 없음): 호출 수 그대로
  const c3 = await reconnect(env);
  assert.deepEqual(c3.closes, []);
  assert.equal(clientDecode(c3.sent[0]).resumed, false);
  assert.equal(env.wire.stats().stoppedCalls, 1);
  assert.equal(env.wire.stats().storeCloseCalls, 1);
});

test('호출자 onStopped 와 store.close 가 던져도 연결 처리는 죽지 않고 close 는 시도로 기록된다', async () => {
  const seen = [];
  const env = await setup({ onStopped: (id, info) => { seen.push([id, info]); throw new Error('알림 실패'); } });
  env.store.close = () => { throw new Error('저장소 실패'); };
  const conn = await reconnect(env);
  assert.deepEqual(conn.closes, [{ code: 1011, reason: 'replay-stopped' }]);
  assert.deepEqual(seen, [[env.sid, { stoppedAt: MISSING_SEQ }]]);
  const s = env.wire.stats();
  assert.equal(s.stoppedCalls, 1);
  assert.equal(s.storeCloseCalls, 1);
  assert.equal(s.onStoppedErrors, 1);
  assert.equal(s.storeCloseErrors, 1);
  assert.deepEqual(env.errors, ['onStopped', 'store.close']);
});

test('같은 sid 정지가 3회면 문턱 표시(저장소 close 가 세션을 못 지울 때 재현)', async () => {
  const env = await setup();
  env.store.close = () => {}; // 닫지 못하는 저장소: 같은 정지가 반복된다
  for (let i = 0; i < 3; i++) {
    assert.equal(env.wire.stats().sameSidThresholdHit, false);
    await reconnect(env);
  }
  const s = env.wire.stats();
  assert.equal(s.stoppedCalls, 3);
  assert.equal(s.storeCloseCalls, 3);
  assert.equal(s.maxSameSidStops, 3);
  assert.equal(s.sameSidThresholdHit, true);
});

test('정지 없는 정상 세션은 둘 다 0', async () => {
  const store = createSessionStore({ maxSessions: 4, ttlMs: 60000, now: () => 0 });
  const seg = pieces(SEG, 2);
  const bytes = new Map(seg.map((p) => [pieceKeyString(p.key), p.bytes]));
  const wire = createWire({ store, loadPiece: (k) => bytes.get(pieceKeyString(k)) ?? null });
  const c1 = fakeConn();
  const api1 = wire.onConnection(c1);
  await c1.msgCb(clientEncode({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 }));
  const sid = api1.sessionId();
  createCoreAdapter({ emit: (m) => api1.emit(m) }).handle({ kind: 'level_arrived', segmentId: SEG, level: LEVEL, pieces: seg });
  c1.closeCb({ code: 1006, reason: '' });
  const c2 = fakeConn();
  wire.onConnection(c2);
  await c2.msgCb(clientEncode({ type: 'HELLO', sessionId: sid, lastPieceSeq: 0 }));
  assert.deepEqual(c2.closes, []);
  assert.equal(clientDecode(c2.sent[0]).resumed, true);
  const s = wire.stats();
  assert.equal(s.stoppedCalls, 0);
  assert.equal(s.storeCloseCalls, 0);
  assert.equal(store.size(), 1);
});

test('createWsServer 는 wire 를 접속 경로에 배선하고 server.stats() 로 계측을 노출한다', async () => {
  const store = createSessionStore({ maxSessions: 2, ttlMs: 60000, now: () => 0 });
  const wire = createWire({ store, loadPiece: () => null });
  const srv = await createWsServer({ host: loopbackHost(), port: 0, wire });
  try {
    assert.deepEqual(srv.stats(), wire.stats());
    assert.equal(srv.stats().stoppedCalls, 0);
    assert.throws(() => createWsServer({ host: loopbackHost(), port: 0 }), TypeError);
  } finally { await srv.close(); }
});
