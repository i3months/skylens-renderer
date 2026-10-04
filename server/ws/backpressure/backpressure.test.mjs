import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackpressure } from './index.mjs';

// 가짜 느린 소비자: send 하면 버퍼가 늘고, drain(n) 으로 n 바이트를 소비한다.
function fakeConn() {
  const c = { buf: 0, sent: [], closed: 0, maxSeen: 0 };
  c.send = (b) => { c.buf += b.length; c.sent.push(b[0]); if (c.buf > c.maxSeen) c.maxSeen = c.buf; };
  c.bufferedAmount = () => c.buf;
  c.close = () => { c.closed++; };
  c.consume = (n) => { c.buf = Math.max(0, c.buf - n); };
  return c;
}
const msg = (id, n) => { const b = new Uint8Array(n); b[0] = id; return b; };
const HIGH = 100, HARD = 200;

test('느린 소비자: 버퍼 상한 초과 0, 큐 합 ≤ 상한, 순서 보존', () => {
  const bp = createBackpressure({ highWaterBytes: HIGH, hardLimitBytes: HARD, maxDecodeMs: 50 });
  const c = fakeConn();
  let maxQueue = 0, over = 0;
  const results = [];
  for (let i = 0; i < 40; i++) {
    const r = bp.trySend(c, msg(i, 30), { droppable: false });
    results.push(r);
    if (c.buf > HARD) over++;
    maxQueue = Math.max(maxQueue, bp.queueInfo(c).bytes);
    if (r === 'closed') break;
    if (i % 5 === 4) { c.consume(70); bp.onDrain(c); if (c.buf > HARD) over++; maxQueue = Math.max(maxQueue, bp.queueInfo(c).bytes); }
  }
  assert.equal(over, 0);
  assert.ok(c.maxSeen <= HARD);
  assert.ok(maxQueue <= HARD);
  assert.ok(results.includes('deferred'));
  // 순서 보존: 보낸 id 가 단조 증가
  for (let i = 1; i < c.sent.length; i++) assert.ok(c.sent[i] > c.sent[i - 1]);
});

test('큐 상한 초과 시 close 호출, 이후 closed', () => {
  const bp = createBackpressure({ highWaterBytes: HIGH, hardLimitBytes: HARD, maxDecodeMs: 50 });
  const c = fakeConn();
  const rs = [];
  for (let i = 0; i < 20; i++) rs.push(bp.trySend(c, msg(i, 50)));
  // 즉시 4개(200 B), 그다음 큐 4개(200 B), 9번째에서 닫힘
  assert.deepEqual(rs.slice(0, 4), ['sent', 'sent', 'sent', 'sent']);
  assert.deepEqual(rs.slice(4, 8), ['deferred', 'deferred', 'deferred', 'deferred']);
  assert.equal(rs[8], 'closed');
  assert.equal(c.closed, 1);
  assert.equal(rs[9], 'closed');
  assert.equal(c.closed, 1);
  assert.ok(c.maxSeen <= HARD);
});

test('droppable 은 넘치면 버리고 큐에 쌓지 않는다', () => {
  const bp = createBackpressure({ highWaterBytes: HIGH, hardLimitBytes: HARD, maxDecodeMs: 50 });
  const c = fakeConn();
  assert.equal(bp.trySend(c, msg(1, 150), { droppable: true }), 'sent');
  assert.equal(bp.trySend(c, msg(2, 60), { droppable: true }), 'dropped');
  assert.equal(bp.queueInfo(c).bytes, 0);
  assert.equal(c.closed, 0);
});

test('onDrain 은 highWater 미만에서 큐를 순서대로 내보낸다', () => {
  const bp = createBackpressure({ highWaterBytes: HIGH, hardLimitBytes: HARD, maxDecodeMs: 50 });
  const c = fakeConn();
  bp.trySend(c, msg(1, 150));
  assert.equal(bp.trySend(c, msg(2, 80)), 'deferred');
  assert.equal(bp.trySend(c, msg(3, 80)), 'deferred');
  c.consume(30); // 120 ≥ highWater: 아직 내보내지 않음
  bp.onDrain(c);
  assert.deepEqual(c.sent, [1]);
  c.consume(100); // 20
  bp.onDrain(); // 인자 없이도 동작
  assert.deepEqual(c.sent, [1, 2]); // 20+80=100 ≥ highWater 에서 멈춤
  c.consume(100);
  bp.onDrain(c);
  assert.deepEqual(c.sent, [1, 2, 3]);
  assert.equal(bp.queueInfo(c).bytes, 0);
});

test('큐가 남은 동안 새 조각은 앞지르지 못한다', () => {
  const bp = createBackpressure({ highWaterBytes: HIGH, hardLimitBytes: HARD, maxDecodeMs: 50 });
  const c = fakeConn();
  bp.trySend(c, msg(1, 190));
  assert.equal(bp.trySend(c, msg(2, 50)), 'deferred');
  assert.equal(bp.trySend(c, msg(3, 5)), 'deferred'); // 들어갈 자리가 있어도 뒤에
  assert.equal(bp.trySend(c, msg(4, 5), { droppable: true }), 'dropped');
});

test('guardRequest: 256 허용, 257 거부, 복호 시간 초과 거부', () => {
  const bp = createBackpressure({ highWaterBytes: HIGH, hardLimitBytes: HARD, maxDecodeMs: 50 });
  const req = (n) => ({ type: 'PIECE_REQUEST', reqId: 1, items: Array.from({ length: n }, () => ({})) });
  assert.deepEqual(bp.guardRequest(req(256), 1010, 1000), { ok: true });
  assert.deepEqual(bp.guardRequest(req(257), 1010, 1000), { ok: false, reason: 'items' });
  assert.deepEqual(bp.guardRequest(req(1), 1050, 1000), { ok: true });
  assert.deepEqual(bp.guardRequest(req(1), 1051, 1000), { ok: false, reason: 'decode_time' });
  assert.equal(bp.guardRequest({ type: 'ACK' }, 1, 0).reason, 'shape');
});
