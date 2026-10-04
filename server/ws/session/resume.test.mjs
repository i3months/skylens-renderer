// replayAfterHello 시험(T12.U S2). 계약: ./contract.mjs. 보낸 바이트는 클라이언트 코덱의 decodeMessage 로 복호해 본다
// (server/proto/codec 의 decodeMessage 는 c→s 종류만 받으므로 s→c 인 WELCOME·PIECE·LEVEL_ARRIVED 는 클라이언트 쪽으로 푼다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { replayAfterHello } from './resume.mjs';
import { replayAfterHello as fromIndex } from './index.mjs';
import { createSessionStore } from '../resume/index.mjs';
import { encodeMessage } from '../../proto/codec/index.mjs';
import { decodeMessage } from '../../../client/proto/index.mjs';
import { collectArrivals } from '../../../contracts/client_raster/arrival.mjs';

const SEG = 7;
const key = (i) => ({ segmentId: SEG, level: 0, lod: 0, chunkIndex: i, tileX: i, tileY: 2 });
// loadPiece 가 돌려줄 조각 바이트(chunkIndex 마다 다르게).
const bytesOf = (i) => new Uint8Array([0xa0 + i, i, 0x5a, i * 3]);

function mkStore() {
  let n = 100;
  return createSessionStore({ maxSessions: 4, ttlMs: 60000, now: () => 1000, randomId: () => n++ });
}
// 새 세션을 열고 조각 seq 1..count 를 기록한 뒤, windows 의 LEVEL_ARRIVED 창을 기록한다.
function seeded(count = 3, windows = [[1, 3]]) {
  const store = mkStore();
  const { sessionId } = store.open({ sessionId: 0, lastPieceSeq: 0 });
  for (let i = 1; i <= count; i++) assert.equal(store.recordSent(sessionId, key(i), i, bytesOf(i)), true);
  for (const [first, last] of windows) {
    assert.equal(store.recordLevelArrived(sessionId, { segmentId: SEG, level: 0, firstPieceSeq: first, pieceCount: last - first + 1 }), true);
  }
  return { store, sessionId };
}
function sink() {
  const sent = [];
  return { sent, send: (b) => { sent.push(b); return true; }, decoded: () => sent.map((b) => decodeMessage(b)) };
}
const loadAll = (k) => bytesOf(k.chunkIndex);

test('index.mjs 가 같은 함수를 내보낸다', () => {
  assert.equal(fromIndex, replayAfterHello);
});

test('(1) 새 세션 HELLO: WELCOME 한 건만, replayed 0', () => {
  const store = mkStore();
  const out = sink();
  const r = replayAfterHello({ store, hello: { sessionId: 0, lastPieceSeq: 0 }, send: out.send, loadPiece: loadAll });
  assert.deepEqual(r, { sessionId: 100, resumed: false, nextPieceSeq: 1, reason: null, replayed: 0, replayedBytes: 0, stoppedAt: null });
  assert.equal(out.sent.length, 1);
  assert.deepEqual(out.decoded(), [{ type: 'WELCOME', sessionId: 100, resumed: false, nextPieceSeq: 1 }]);
});

test('(2) 이어받기 lastPieceSeq=1: WELCOME(resumed) 뒤 PIECE 2, 3, LEVEL_ARRIVED 순으로 replayed 3', () => {
  const { store, sessionId } = seeded();
  const out = sink();
  const loaded = [];
  const r = replayAfterHello({
    store, hello: { sessionId, lastPieceSeq: 1 }, send: out.send,
    loadPiece: (k) => { loaded.push(k.chunkIndex); return bytesOf(k.chunkIndex); },
  });
  const sentBytes = out.sent.slice(1).reduce((n, b) => n + b.length, 0);
  assert.deepEqual(r, { sessionId: 100, resumed: true, nextPieceSeq: 4, reason: null, replayed: 3, replayedBytes: sentBytes, stoppedAt: null });
  assert.ok(sentBytes > 0);
  assert.deepEqual(loaded, [2, 3]);
  assert.equal(out.sent.length, 4);
  const msgs = out.decoded();
  assert.deepEqual(msgs, [
    { type: 'WELCOME', sessionId: 100, resumed: true, nextPieceSeq: 4 },
    { type: 'PIECE', pieceSeq: 2, key: key(2), chunk: bytesOf(2) },
    { type: 'PIECE', pieceSeq: 3, key: key(3), chunk: bytesOf(3) },
    { type: 'LEVEL_ARRIVED', segmentId: SEG, level: 0, pieceCount: 3, firstPieceSeq: 1 },
  ]);
  // 클라이언트 쪽 판정: 첫 연결에서 받은 WELCOME·PIECE 1 에 이어 붙이면 창 1..3 이 완료 3 key 로 세어진다.
  const before = [
    { type: 'WELCOME', sessionId: 100, resumed: false, nextPieceSeq: 1 },
    { type: 'PIECE', pieceSeq: 1, key: key(1), chunk: bytesOf(1) },
  ];
  const { arrived } = collectArrivals([...before, ...msgs]);
  assert.equal(arrived.length, 1);
  assert.deepEqual(arrived[0], { segmentId: SEG, level: 0, keys: ['1', '2', '3'].map((n) => ['7', '0', n, '2', '0', n].join('.')) });
});

test('(3) LEVEL_ARRIVED 만 유실(lastPieceSeq == 마지막 조각 3): LEVEL_ARRIVED 한 건, replayed 1', () => {
  const { store, sessionId } = seeded();
  const out = sink();
  const r = replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 3 }, send: out.send, loadPiece: () => assert.fail('조각을 읽으면 안 된다') });
  assert.equal(r.replayed, 1);
  assert.equal(r.resumed, true);
  assert.deepEqual(out.decoded(), [
    { type: 'WELCOME', sessionId: 100, resumed: true, nextPieceSeq: 4 },
    { type: 'LEVEL_ARRIVED', segmentId: SEG, level: 0, pieceCount: 3, firstPieceSeq: 1 },
  ]);
});

test('(4) loadPiece 가 null 이면 그 순번에서 멈춘다: 뒤 PIECE·LEVEL_ARRIVED 는 보내지 않고 stoppedAt 에 순번', () => {
  // 창 하나: seq 2 바이트 없음 → PIECE 3 도 LEVEL_ARRIVED 도 안 나간다, replayed 0.
  {
    const { store, sessionId } = seeded();
    const out = sink();
    const loaded = [];
    const r = replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 1 }, send: out.send, loadPiece: (k) => { loaded.push(k.chunkIndex); return k.chunkIndex === 2 ? null : bytesOf(k.chunkIndex); } });
    assert.equal(r.replayed, 0);
    assert.equal(r.replayedBytes, 0);
    assert.equal(r.stoppedAt, 2);
    assert.deepEqual(loaded, [2]);
    assert.deepEqual(out.decoded(), [{ type: 'WELCOME', sessionId: 100, resumed: true, nextPieceSeq: 4 }]);
  }
  // 창 하나: seq 3 바이트 없음 → PIECE 2 만, LEVEL_ARRIVED 없음.
  {
    const { store, sessionId } = seeded();
    const out = sink();
    const r = replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 1 }, send: out.send, loadPiece: (k) => (k.chunkIndex === 3 ? null : bytesOf(k.chunkIndex)) });
    assert.equal(r.replayed, 1);
    assert.equal(r.stoppedAt, 3);
    assert.deepEqual(out.decoded().map((m) => [m.type, m.pieceSeq]), [['WELCOME', undefined], ['PIECE', 2]]);
  }
  // 창 두 개(1..3, 4..5): seq 2 바이트 없음 → 둘째 창의 PIECE·LEVEL_ARRIVED 도 보내지 않는다.
  {
    const { store, sessionId } = seeded(5, [[1, 3], [4, 5]]);
    const out = sink();
    const r = replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 1 }, send: out.send, loadPiece: (k) => (k.chunkIndex === 2 ? null : bytesOf(k.chunkIndex)) });
    assert.equal(r.replayed, 0);
    assert.equal(r.stoppedAt, 2);
    assert.equal(out.sent.length, 1);
  }
});

test('(4b) 감독 재현: 구간1 seq1·2·LA(1..2), 구간2 seq3·LA(3..3), seq2 없음 → ACK(3) 뒤에도 seq2 가 후보로 남는다', () => {
  const store = mkStore();
  const { sessionId } = store.open({ sessionId: 0, lastPieceSeq: 0 });
  const k = (seg, i) => ({ segmentId: seg, level: 1, lod: 0, chunkIndex: i, tileX: i, tileY: 0 });
  store.recordSent(sessionId, k(1, 1), 1, bytesOf(1));
  store.recordSent(sessionId, k(1, 2), 2, bytesOf(2));
  store.recordLevelArrived(sessionId, { segmentId: 1, level: 1, firstPieceSeq: 1, pieceCount: 2 });
  store.recordSent(sessionId, k(2, 3), 3, bytesOf(3));
  store.recordLevelArrived(sessionId, { segmentId: 2, level: 1, firstPieceSeq: 3, pieceCount: 1 });
  const out = sink();
  const r = replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 0 }, send: out.send, loadPiece: (key) => (key.chunkIndex === 2 ? null : bytesOf(key.chunkIndex)) });
  // 멈추기 전에 P1 만 나간다. P3·LEVEL_ARRIVED(seg2) 는 나가지 않는다.
  assert.deepEqual(out.decoded().map((m) => [m.type, m.pieceSeq]), [['WELCOME', undefined], ['PIECE', 1]]);
  assert.equal(r.stoppedAt, 2);
  assert.equal(r.replayed, 1);
  // 클라이언트는 받은 것까지(seq 1)만 확인한다. seq2·LEVEL_ARRIVED(seg1) 는 다시 후보다.
  const out2 = sink();
  const r2 = replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 1 }, send: out2.send, loadPiece: loadAll });
  assert.equal(r2.stoppedAt, null);
  assert.deepEqual(out2.decoded().map((m) => [m.type, m.pieceSeq ?? m.firstPieceSeq]), [['WELCOME', undefined], ['PIECE', 2], ['LEVEL_ARRIVED', 1], ['PIECE', 3], ['LEVEL_ARRIVED', 3]]);
});

test('(4c) loadPiece 가 undefined 를 돌려줘도 null 과 같게 멈춘다', () => {
  const { store, sessionId } = seeded();
  const out = sink();
  const r = replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 0 }, send: out.send, loadPiece: (k) => (k.chunkIndex === 2 ? undefined : bytesOf(k.chunkIndex)) });
  assert.equal(r.stoppedAt, 2);
  assert.equal(r.replayed, 1);
  assert.deepEqual(out.decoded().map((m) => [m.type, m.pieceSeq]), [['WELCOME', undefined], ['PIECE', 1]]);
});

test('(4d) resendPlan 이 모르는 종류를 주면 TypeError', () => {
  const store = {
    open: () => ({ sessionId: 1, resumed: true, nextPieceSeq: 1, reason: null }),
    resendPlan: () => [{ type: 'MYSTERY' }],
  };
  const out = sink();
  assert.throws(() => replayAfterHello({ store, hello: { sessionId: 1, lastPieceSeq: 0 }, send: out.send, loadPiece: loadAll }), TypeError);
  assert.equal(out.sent.length, 1); // WELCOME 만 나갔다
});

test('(5) 모르는 세션 이어받기: WELCOME resumed=0, reason UNKNOWN_SESSION, 재전송 0', () => {
  const { store } = seeded();
  const out = sink();
  const r = replayAfterHello({ store, hello: { sessionId: 999, lastPieceSeq: 1 }, send: out.send, loadPiece: () => assert.fail('조각을 읽으면 안 된다') });
  assert.deepEqual(r, { sessionId: 101, resumed: false, nextPieceSeq: 1, reason: 'UNKNOWN_SESSION', replayed: 0, replayedBytes: 0, stoppedAt: null });
  assert.equal(out.sent.length, 1);
  assert.deepEqual(out.decoded(), [{ type: 'WELCOME', sessionId: 101, resumed: false, nextPieceSeq: 1 }]);
});

test('(6) 재전송 도중 send 가 던지면 전파되고 저장소는 그대로라 다시 HELLO 하면 같은 재전송', () => {
  const { store, sessionId } = seeded();
  // 같은 HELLO 의 open 은 멱등이다: 먼저 한 번 열어 'HELLO 직후' 상태를 찍어 두고, 재전송이 그 상태를 바꾸지 않는지 본다.
  store.open({ sessionId, lastPieceSeq: 1 });
  const planBefore = store.resendPlan(sessionId);
  assert.equal(planBefore.length, 3);
  const statsBefore = store.stats(sessionId);
  const boom = new Error('선 끊김');
  const partial = [];
  let calls = 0;
  const failing = (b) => { if (++calls === 3) throw boom; partial.push(b); }; // WELCOME, PIECE 2 뒤 PIECE 3 에서 던진다
  assert.throws(() => replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 1 }, send: failing, loadPiece: loadAll }), (e) => e === boom);
  assert.equal(partial.length, 2);
  assert.deepEqual(store.resendPlan(sessionId), planBefore);
  assert.deepEqual(store.stats(sessionId), statsBefore);

  const out = sink();
  const r = replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 1 }, send: out.send, loadPiece: loadAll });
  assert.equal(r.replayed, 3);
  assert.deepEqual(out.decoded().map((m) => [m.type, m.pieceSeq ?? m.firstPieceSeq]), [['WELCOME', undefined], ['PIECE', 2], ['PIECE', 3], ['LEVEL_ARRIVED', 1]]);
  // 앞서 실패한 시도가 보낸 바이트는 다시 보낸 앞부분과 같다.
  assert.deepEqual(partial, out.sent.slice(0, 2));
});

test('(7) 재전송 도중 send 안에서 ack·새 기록이 끼어도 던지지 않고 시작 때 찍은 계획을 그대로 보낸다', () => {
  const { store, sessionId } = seeded();
  const out = sink();
  let n = 0;
  const send = (b) => {
    out.sent.push(b);
    if (++n === 2) {
      // PIECE 2 를 보낸 직후: 클라이언트 ACK 3 과 어댑터의 새 조각·새 수준 기록이 끼어든다.
      store.ack(sessionId, 3);
      assert.equal(store.recordSent(sessionId, key(4), 4, bytesOf(4)), true);
      assert.equal(store.recordLevelArrived(sessionId, { segmentId: SEG, level: 0, firstPieceSeq: 4, pieceCount: 1 }), true);
    }
  };
  const r = replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 1 }, send, loadPiece: loadAll });
  assert.equal(r.replayed, 3);
  assert.deepEqual(out.decoded().map((m) => [m.type, m.pieceSeq ?? m.firstPieceSeq]), [['WELCOME', undefined], ['PIECE', 2], ['PIECE', 3], ['LEVEL_ARRIVED', 1]]);
});

test('encode 주입: 기본은 server/proto/codec encodeMessage 와 같은 바이트', () => {
  const { store, sessionId } = seeded();
  const seen = [];
  const out = sink();
  replayAfterHello({ store, hello: { sessionId, lastPieceSeq: 1 }, send: out.send, loadPiece: loadAll, encode: (m) => { seen.push(m.type); return encodeMessage(m); } });
  assert.deepEqual(seen, ['WELCOME', 'PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  const { store: s2, sessionId: id2 } = seeded();
  const out2 = sink();
  replayAfterHello({ store: s2, hello: { sessionId: id2, lastPieceSeq: 1 }, send: out2.send, loadPiece: loadAll });
  assert.deepEqual(out2.sent, out.sent);
});

test('인자 검사: 함수가 아니면 TypeError 이고 아무것도 보내지 않는다', () => {
  const store = mkStore();
  const out = sink();
  assert.throws(() => replayAfterHello({ store, hello: { sessionId: 0, lastPieceSeq: 0 }, send: out.send }), TypeError);
  assert.throws(() => replayAfterHello({ store, hello: { sessionId: 0, lastPieceSeq: 0 }, loadPiece: loadAll }), TypeError);
  assert.throws(() => replayAfterHello({ hello: { sessionId: 0, lastPieceSeq: 0 }, send: out.send, loadPiece: loadAll }), TypeError);
  assert.equal(out.sent.length, 0);
  assert.equal(store.size(), 0);
});
