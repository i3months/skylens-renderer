// 접속 배선 가장자리 시험: 정수 아닌 stoppedAt, 닫힘 콜백 중복.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachConnection, CLOSE_REASON_INTERNAL } from './connection.mjs';
import { encodeMessage as clientEncode } from '../../../client/proto/index.mjs';

function fakeConn() {
  const c = { sent: [], closes: [], msgCb: null, closeCb: null };
  c.send = (b) => { c.sent.push(b); return true; };
  c.onMessage = (cb) => { c.msgCb = cb; };
  c.onClose = (cb) => { c.closeCb = cb; };
  c.close = (code, reason = '') => { c.closes.push({ code, reason }); };
  c.bufferedAmount = () => 0;
  return c;
}
const HELLO = () => clientEncode({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 });

for (const bad of [NaN, '3', 1.5, Infinity, {}]) {
  test(`stoppedAt ${typeof bad === 'object' ? 'object' : String(bad)} 는 정지가 아니라 내부 오류 1011 internal-error`, async () => {
    const conn = fakeConn();
    let sessions = 0;
    let stops = 0;
    let makes = 0;
    attachConnection({
      conn, store: {}, loadPiece: () => null,
      replay: async () => ({ sessionId: 7, resumed: true, nextPieceSeq: 1, stoppedAt: bad }),
      makeEmit: () => { makes++; return () => {}; },
      onSession: () => { sessions++; },
      onStopped: () => { stops++; },
    });
    await conn.msgCb(HELLO());
    assert.deepEqual(conn.closes, [{ code: 1011, reason: CLOSE_REASON_INTERNAL }]);
    assert.equal(stops, 0);
    assert.equal(sessions, 0);
    assert.equal(makes, 0);
  });
}

test('stoppedAt 정수는 정지(replay-stopped)로 처리한다', async () => {
  const conn = fakeConn();
  const stops = [];
  attachConnection({
    conn, store: {}, loadPiece: () => null,
    replay: async () => ({ sessionId: 7, resumed: true, nextPieceSeq: 1, stoppedAt: 2 }),
    onStopped: (id, info) => stops.push([id, info]),
  });
  await conn.msgCb(HELLO());
  assert.deepEqual(conn.closes, [{ code: 1011, reason: 'replay-stopped' }]);
  assert.deepEqual(stops, [[7, { stoppedAt: 2 }]]);
});

test('conn 닫힘 콜백이 두 번 불려도 onClose 는 한 번', () => {
  const conn = fakeConn();
  const infos = [];
  attachConnection({ conn, store: {}, loadPiece: () => null, onClose: (i) => infos.push(i) });
  conn.closeCb({ code: 1006, reason: '' });
  conn.closeCb({ code: 1000, reason: 'x' });
  assert.deepEqual(infos, [{ code: 1006, reason: '' }]);
});

// replay 대기 중 접속이 닫힌 뒤의 stoppedAt 처리(Number.isInteger 검사가 닫힘 경로에서도 필요하다).
for (const [label, stoppedAt, expected] of [['NaN', NaN, 0], ['정수', 2, 1]]) {
  test(`replay 대기 중 closeCb 뒤 stoppedAt ${label} 이면 onStopped ${expected}회`, async () => {
    const conn = fakeConn();
    const stops = [];
    let release;
    attachConnection({
      conn, store: {}, loadPiece: () => null,
      replay: () => new Promise((r) => { release = () => r({ sessionId: 7, resumed: true, nextPieceSeq: 1, stoppedAt }); }),
      onStopped: (id, info) => stops.push([id, info]),
    });
    const pending = conn.msgCb(HELLO());
    await new Promise((r) => setImmediate(r));
    conn.closeCb({ code: 1006, reason: '' });
    release();
    await pending;
    await new Promise((r) => setImmediate(r));
    assert.equal(stops.length, expected);
    if (expected) assert.deepEqual(stops, [[7, { stoppedAt: 2 }]]);
  });
}
