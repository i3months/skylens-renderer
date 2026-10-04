// 비동기 콜백 거부 시험(F-282).
//   onSession 이 thenable 을 돌려주고 거부하면 close(1011) 1회, 그 뒤 emit 은 던진다.
//   onClose·onStopped 의 거부는 삼킨다. 어느 경우든 unhandledRejection 0개.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachConnection, CLOSE_REASON_INTERNAL } from './connection.mjs';
import { encodeMessage as clientEncode } from '../../../client/proto/index.mjs';

const CLOSE_INTERNAL = 1011;

function fakeConn() {
  const c = { sent: [], closes: [], msgCb: null, closeCb: null };
  c.send = (b) => { c.sent.push(b); return true; };
  c.onMessage = (cb) => { c.msgCb = cb; };
  c.onClose = (cb) => { c.closeCb = cb; };
  c.close = (code, reason = '') => { c.closes.push({ code, reason }); if (c.closeCb) c.closeCb({ code, reason }); };
  return c;
}
const hello = () => clientEncode({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 });
const okReplay = async () => ({ sessionId: 7, resumed: false, nextPieceSeq: 1, stoppedAt: null });
// 거부가 처리되거나 unhandledRejection 으로 보고될 때까지 넉넉히 양보한다.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** 시험 동안 unhandledRejection 을 센다. */
function trackUnhandled() {
  const seen = [];
  const h = (reason) => seen.push(reason);
  process.on('unhandledRejection', h);
  return { seen, stop: () => process.off('unhandledRejection', h) };
}

test('onSession 이 거부하는 promise 를 돌려주면 close(1011) 1회, emit 던짐, unhandledRejection 0', async () => {
  const u = trackUnhandled();
  try {
    const conn = fakeConn();
    const api = attachConnection({
      conn, store: { ack() {} }, loadPiece: () => null, replay: okReplay,
      makeEmit: () => () => {},
      onSession: async () => { throw new Error('onSession 비동기 실패'); },
    });
    await conn.msgCb(hello());
    await settle();
    assert.deepEqual(conn.closes, [{ code: CLOSE_INTERNAL, reason: CLOSE_REASON_INTERNAL }]);
    assert.throws(() => api.emit({ type: 'MISSING', segmentId: 1 }));
    assert.equal(u.seen.length, 0);
  } finally { u.stop(); }
});

test('onSession 이 거부하는 thenable(비 Promise)을 돌려줘도 close(1011) 1회', async () => {
  const u = trackUnhandled();
  try {
    const conn = fakeConn();
    attachConnection({
      conn, store: { ack() {} }, loadPiece: () => null, replay: okReplay,
      makeEmit: () => () => {},
      onSession: () => ({ then(_ok, fail) { fail(new Error('thenable 거부')); } }),
    });
    await conn.msgCb(hello());
    await settle();
    assert.equal(conn.closes.length, 1);
    assert.equal(conn.closes[0].code, CLOSE_INTERNAL);
    assert.equal(u.seen.length, 0);
  } finally { u.stop(); }
});

test('onSession 거부가 접속이 이미 닫힌 뒤 와도 close 를 다시 부르지 않음', async () => {
  const u = trackUnhandled();
  try {
    const conn = fakeConn();
    let fail;
    attachConnection({
      conn, store: { ack() {} }, loadPiece: () => null, replay: okReplay,
      makeEmit: () => () => {},
      onSession: () => new Promise((_, rej) => { fail = rej; }),
    });
    await conn.msgCb(hello());
    conn.closeCb({ code: 1006, reason: '' });
    fail(new Error('뒤늦은 실패'));
    await settle();
    assert.deepEqual(conn.closes, []);
    assert.equal(u.seen.length, 0);
  } finally { u.stop(); }
});

test('onSession 이 해소되는 promise 면 닫지 않고 emit 동작', async () => {
  const conn = fakeConn();
  const emitted = [];
  const api = attachConnection({
    conn, store: { ack() {} }, loadPiece: () => null, replay: okReplay,
    makeEmit: () => (m) => emitted.push(m.type),
    onSession: async () => {},
  });
  await conn.msgCb(hello());
  await settle();
  assert.deepEqual(conn.closes, []);
  api.emit({ type: 'MISSING', segmentId: 1 });
  assert.deepEqual(emitted, ['MISSING']);
});

test('onClose 가 거부해도 unhandledRejection 0', async () => {
  const u = trackUnhandled();
  try {
    const conn = fakeConn();
    let calls = 0;
    attachConnection({
      conn, store: { ack() {} }, loadPiece: () => null, replay: okReplay,
      makeEmit: () => () => {},
      onClose: async () => { calls += 1; throw new Error('onClose 비동기 실패'); },
    });
    await conn.msgCb(hello());
    conn.closeCb({ code: 1000, reason: '' });
    await settle();
    assert.equal(calls, 1);
    assert.equal(u.seen.length, 0);
  } finally { u.stop(); }
});

test('onStopped 가 거부해도 unhandledRejection 0', async () => {
  const u = trackUnhandled();
  try {
    const conn = fakeConn();
    let calls = 0;
    attachConnection({
      conn, store: { ack() {} }, loadPiece: () => null,
      replay: async () => ({ sessionId: 7, resumed: true, nextPieceSeq: 3, stoppedAt: 2 }),
      onStopped: async () => { calls += 1; throw new Error('onStopped 비동기 실패'); },
    });
    await conn.msgCb(hello());
    await settle();
    assert.equal(calls, 1);
    assert.equal(conn.closes.length, 1);
    assert.equal(u.seen.length, 0);
  } finally { u.stop(); }
});
