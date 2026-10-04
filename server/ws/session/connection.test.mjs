// attachConnection 시험. 가짜 접속 객체·가짜 store 를 주입하고 replay·makeEmit 도 덮어써 다른 모듈을 거치지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachConnection } from './connection.mjs';
import { encodeMessage, decodeMessage } from '../../proto/codec/index.mjs';

function fakeConn() {
  const c = { sent: [], closes: [], msgCb: null, closeCb: null };
  c.send = (b) => { c.sent.push(b); return true; };
  c.onMessage = (cb) => { c.msgCb = cb; };
  c.onClose = (cb) => { c.closeCb = cb; };
  c.close = (code) => { c.closes.push(code); };
  c.bufferedAmount = () => 0;
  return c;
}
function fakeStore() {
  const s = { acks: [], closes: 0 };
  s.ack = (id, seq) => { s.acks.push([id, seq]); };
  s.close = () => { s.closes += 1; };
  return s;
}
const hello = (sessionId = 0) => encodeMessage({ type: 'HELLO', sessionId, lastPieceSeq: 0 });
const ack = (n) => encodeMessage({ type: 'ACK', upToPieceSeq: n });
const okReplay = async () => ({ sessionId: 7, resumed: false });
const setup = (extra = {}) => {
  const conn = fakeConn();
  const store = fakeStore();
  const emitted = [];
  const sessions = [];
  const api = attachConnection({
    conn, store, loadPiece: () => null, replay: okReplay,
    makeEmit: () => (m) => emitted.push(m), onSession: (id, info) => sessions.push([id, info]), ...extra,
  });
  return { conn, store, emitted, sessions, api };
};

test('HELLO 전 emit 은 던진다', () => {
  const { api } = setup();
  assert.throws(() => api.emit({ type: 'MISSING' }));
});

test('잘못된 첫 메시지: ERROR code 1 한 번, close(1002) 한 번', async () => {
  const { conn } = setup();
  await conn.msgCb(ack(1));
  assert.equal(conn.sent.length, 1);
  const bytes = conn.sent[0];
  assert.equal(bytes[0], 9); // ERROR
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true), 1);
  assert.deepEqual(conn.closes, [1002]);
});

test('복호 실패한 첫 메시지도 ERROR + close(1002)', async () => {
  const { conn } = setup();
  await conn.msgCb(new Uint8Array([1, 2, 3]));
  assert.equal(conn.sent.length, 1);
  assert.deepEqual(conn.closes, [1002]);
});

test('HELLO 뒤 ACK 두 번은 store.ack 2회, 값 전달', async () => {
  const { conn, store } = setup();
  await conn.msgCb(hello());
  await conn.msgCb(ack(3));
  await conn.msgCb(ack(9));
  assert.deepEqual(store.acks, [[7, 3], [7, 9]]);
});

test('onSession 1회, 둘째 HELLO 는 무시, emit 은 HELLO 뒤 동작', async () => {
  const { conn, sessions, emitted, api } = setup();
  await conn.msgCb(hello());
  await conn.msgCb(hello(7));
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], [7, { resumed: false }]);
  assert.equal(conn.closes.length, 0);
  api.emit({ type: 'MISSING' });
  assert.equal(emitted.length, 1);
  assert.equal(api.sessionId(), 7);
});

test('VIEW_UPDATE 는 onMessage 로만 넘어가고 store 를 건드리지 않는다', async () => {
  const seen = [];
  const { conn, store } = setup({ onMessage: (m) => seen.push(m.type) });
  await conn.msgCb(hello());
  await conn.msgCb(encodeMessage({ type: 'VIEW_UPDATE', viewSeq: 1, pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: 1, width: 640, height: 480 }));
  assert.deepEqual(seen, ['VIEW_UPDATE']);
  assert.equal(store.acks.length, 0);
});

test('닫힘 뒤 store.close 0회', async () => {
  const { conn, store } = setup();
  await conn.msgCb(hello());
  conn.closeCb({ code: 1000, reason: '' });
  assert.equal(store.closes, 0);
});

test('replay 가 던지면 close(1011) 한 번, onSession 0회', async () => {
  const { conn, sessions } = setup({ replay: async () => { throw new Error('실패'); } });
  await conn.msgCb(hello());
  assert.deepEqual(conn.closes, [1011]);
  assert.equal(sessions.length, 0);
});
