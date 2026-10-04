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

test('onSession 1회, emit 은 HELLO 뒤 동작, 둘째 HELLO 는 ERROR 와 close(1002) (F-270 ④)', async () => {
  const { conn, sessions, emitted, api } = setup();
  await conn.msgCb(hello());
  api.emit({ type: 'MISSING' });
  assert.equal(emitted.length, 1);
  assert.equal(api.sessionId(), 7);
  await conn.msgCb(hello(7));
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], [7, { resumed: false, nextPieceSeq: undefined }]);
  assert.deepEqual(conn.closes, [1002]);
  assert.throws(() => api.emit({ type: 'MISSING' }), /닫/);
  assert.equal(emitted.length, 1, '거부된 emit 은 나가지 않는다');
  assert.equal(conn.sent.length, 1, '둘째 HELLO 거부 ERROR 한 건');
  assert.equal(conn.sent[0][0], 9);
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

test('(a) onMessage 옵션이 던지면 conn.close(1011) 1회', async () => {
  // onMessage 콜백이 예외를 던지면 CLOSE_INTERNAL_ERROR(1011)로 종료
  const { conn } = setup({ onMessage: () => { throw new Error('처리 실패'); } });
  await conn.msgCb(hello());
  await conn.msgCb(encodeMessage({ type: 'VIEW_UPDATE', viewSeq: 1, pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: 1, width: 640, height: 480 }));
  assert.deepEqual(conn.closes, [1011]);
});

test('(b) 닫힘 뒤 도착한 ACK 는 store.ack 를 부르지 않음', async () => {
  // 접속이 닫힌 후 도착한 메시지는 조기에 반환되어 store.ack 를 부르지 않음
  const { conn, store } = setup();
  await conn.msgCb(hello());
  conn.closeCb({ code: 1000, reason: '' });
  // 닫힘 상태에서 ACK 도착
  await conn.msgCb(ack(5));
  assert.deepEqual(store.acks, []); // store.ack 가 호출되지 않음
});

test('(c) conn.onClose 에 등록한 콜백이 닫힘 때 옵션 onClose 를 1회 호출', async () => {
  // onClose 콜백이 정확히 1회 호출되고 info 를 받음
  const closeCalls = [];
  const { conn } = setup({ onClose: (info) => closeCalls.push(info) });
  await conn.msgCb(hello());
  conn.closeCb({ code: 1000, reason: 'normal' });
  assert.equal(closeCalls.length, 1);
  assert.deepEqual(closeCalls[0], { code: 1000, reason: 'normal' });
});

test('(d) HELLO 이후 ACK·VIEW_UPDATE 가 onMessage 로 가는지/안 가는지 단언', async () => {
  // ACK 는 onMessage 로 가지 않고 store.ack 를 부른다
  // VIEW_UPDATE 는 onMessage 로 간다
  const seen = [];
  const { conn, store } = setup({ onMessage: (m) => seen.push(m.type) });
  await conn.msgCb(hello());
  await conn.msgCb(ack(3));
  await conn.msgCb(encodeMessage({ type: 'VIEW_UPDATE', viewSeq: 1, pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: 1, width: 640, height: 480 }));
  // ACK 는 onMessage 로 가지 않음(store.ack 로만 감)
  assert.deepEqual(seen, ['VIEW_UPDATE']);
  // ACK 는 store.ack 로 처리됨
  assert.equal(store.acks.length, 1);
});

test('(e) HELLO 직후 ACK 가 한 청크로 동시에 도착해도 순서대로 처리', async () => {
  // 비동기 replay 중에도 chain 으로 인해 ACK 가 순서대로 처리됨
  const { conn, store } = setup({
    replay: async () => {
      // 비동기 작업 시뮬레이션으로 HELLO 처리가 느리게 진행
      await new Promise(r => setTimeout(r, 5));
      return { sessionId: 7, resumed: false };
    },
  });
  // HELLO 와 ACK 를 동시에 전달(await 없이 연속 호출)
  // chain 이 없으면 ACK 가 emitFn 이 설정되기 전에 처리되어 무시됨
  const helloPromise = conn.msgCb(hello());
  const ackPromise = conn.msgCb(ack(5));
  // 둘 다 기다렸다가 순서대로 처리되었는지 확인
  await helloPromise;
  await ackPromise;
  // HELLO 가 먼저 처리되고 그 뒤 ACK 가 처리되어 store.ack 가 호출됨
  assert.deepEqual(store.acks, [[7, 5]]);
});

test('(f) 가짜 replay·makeEmit 이 받은 인자를 단언', async () => {
  // replay 와 makeEmit 가 올바른 인자를 받는지 확인
  const recordedReplayArgs = [];
  const recordedMakeEmitArgs = [];
  const { conn } = setup({
    replay: async (args) => {
      recordedReplayArgs.push(args);
      return { sessionId: 7, resumed: false };
    },
    makeEmit: (args) => {
      recordedMakeEmitArgs.push(args);
      return (m) => {};
    },
  });
  await conn.msgCb(hello());
  // replay 가 받은 인자 확인
  assert.equal(recordedReplayArgs.length, 1);
  const replayArgs = recordedReplayArgs[0];
  assert.ok(replayArgs.store);
  assert.ok(replayArgs.hello);
  assert.equal(replayArgs.hello.type, 'HELLO');
  assert.equal(typeof replayArgs.send, 'function');
  assert.equal(typeof replayArgs.loadPiece, 'function');
  assert.equal(typeof replayArgs.encode, 'function');
  // makeEmit 이 받은 인자 확인
  assert.equal(recordedMakeEmitArgs.length, 1);
  const emitArgs = recordedMakeEmitArgs[0];
  assert.ok(emitArgs.store);
  assert.equal(emitArgs.sessionId, 7);
  assert.equal(typeof emitArgs.send, 'function');
  assert.equal(typeof emitArgs.encode, 'function');
});
