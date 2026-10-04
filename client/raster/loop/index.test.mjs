// T12.5 시험: 가짜 시계·가짜 requestFrame 으로 결정적. 벽시계 단언 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameLoop, createDecodeWorkerClient, LONG_TASK_MS } from './index.mjs';

function rig() {
  let t = 0, q = [];
  return {
    now: () => t, advance: (ms) => { t += ms; },
    requestFrame: (cb) => { q.push(cb); },
    step(ms = 1000 / 60) { t += ms; const c = q; q = []; c.forEach((f) => f()); },
    queued: () => q.length,
  };
}

test('도착 폭주 100 건이어도 프레임당 draw 는 한 번', () => {
  const r = rig(); let draws = 0;
  const loop = createFrameLoop({ draw: () => { draws++; }, requestFrame: r.requestFrame, now: r.now });
  loop.start(); r.step(); assert.equal(draws, 1);
  for (let i = 0; i < 100; i++) loop.notifyArrival();
  r.step(); assert.equal(draws, 2);
  const s = loop.stats();
  assert.equal(s.arrivals, 100); assert.equal(s.coalescedArrivals, 99); assert.equal(s.droppedFrames, 0);
});

test('도착이 없으면 그리지 않는다', () => {
  const r = rig(); let draws = 0;
  const loop = createFrameLoop({ draw: () => { draws++; }, requestFrame: r.requestFrame, now: r.now });
  loop.start(); r.step(); r.step(); r.step();
  assert.equal(draws, 1); assert.equal(loop.stats().frames, 3);
});

test('프레임이 늦으면 건너뛴 수를 센다 (간격 4 프레임 → 3)', () => {
  const r = rig();
  const loop = createFrameLoop({ draw() {}, requestFrame: r.requestFrame, now: r.now, frameMs: 16 });
  loop.start(); r.step(16); r.step(16); assert.equal(loop.stats().droppedFrames, 0);
  r.step(64); assert.equal(loop.stats().droppedFrames, 3);
});

test('stop 뒤에는 콜백이 와도 그리지 않고 다시 요청하지 않는다', () => {
  const r = rig(); let draws = 0;
  const loop = createFrameLoop({ draw: () => { draws++; }, requestFrame: r.requestFrame, now: r.now });
  loop.start(); loop.stop(); r.step();
  assert.equal(draws, 0); assert.equal(r.queued(), 0);
  loop.start(); r.step(); assert.equal(draws, 1);
});

test('draw 가 50 ms 를 넘으면 longTasks 로 센다, 이하면 0', () => {
  const r = rig(); let cost = 20;
  const loop = createFrameLoop({ draw: () => r.advance(cost), requestFrame: r.requestFrame, now: r.now });
  loop.start(); r.step(); loop.notifyArrival(); r.step();
  assert.equal(loop.stats().longTasks, 0);
  cost = 51; loop.notifyArrival(); r.step();
  assert.equal(loop.stats().longTasks, 1); assert.equal(LONG_TASK_MS, 50);
});

function fakeWorker(r, costMs) {
  const w = { onmessage: null, onerror: null, sent: [],
    postMessage(m) { r.advance(1); w.sent.push(m); },
    terminate() { w.dead = true; } };
  // 응답 배달 중 메인 스레드가 costMs 를 쓴 것으로 흉내(data 접근 시 시계가 간다)
  w.reply = (data) => { w.onmessage({ get data() { r.advance(costMs); return data; } }); };
  return w;
}

test('복호 Worker: 메인 스레드 long task 0, 요청·응답 짝이 맞음', async () => {
  const r = rig(); const w = fakeWorker(r, 2);
  const c = createDecodeWorkerClient({ spawn: () => w, now: r.now });
  const p1 = c.decode(new Uint8Array([1, 2, 3]));
  const p2 = c.decode(new Uint8Array([4]));
  assert.equal(w.sent.length, 2);
  w.reply({ id: w.sent[1].id, result: 'b' }); w.reply({ id: w.sent[0].id, result: 'a' });
  assert.equal(await p1, 'a'); assert.equal(await p2, 'b');
  const s = c.stats();
  assert.equal(s.requests, 2); assert.equal(s.responses, 2); assert.equal(s.mainThreadEvents, 4);
  assert.equal(s.longTasks, 0); assert.equal(s.pending, 0);
});

test('복호 Worker: 오류 응답과 onerror 는 reject, 메인 쪽 51 ms 작업은 long task 1', async () => {
  const r = rig(); const w = fakeWorker(r, 51);
  const c = createDecodeWorkerClient({ spawn: () => w, now: r.now });
  const p = c.decode(new Uint8Array(1));
  w.reply({ id: w.sent[0].id, error: 'bad' });
  await assert.rejects(p, /bad/);
  assert.equal(c.stats().longTasks, 1); assert.equal(c.stats().errors, 1);
  const q = c.decode(new Uint8Array(1));
  w.onerror(new Error('boom'));
  await assert.rejects(q, /boom/); assert.equal(c.stats().pending, 0);
  c.terminate(); assert.equal(w.dead, true);
});

test('draw 예외 뒤에도 다음 프레임을 예약하고 오류를 알린다', () => {
  const r = rig(); const errs = []; let n = 0;
  const loop = createFrameLoop({ draw: () => { n++; if (n === 1) throw new Error('gl'); }, requestFrame: r.requestFrame, now: r.now,
    onError: (e, where) => errs.push([e.message, where]) });
  loop.start(); r.step();
  assert.equal(r.queued(), 1); assert.deepEqual(errs, [['gl', 'draw']]);
  loop.notifyArrival(); r.step(); assert.equal(n, 2); assert.equal(loop.stats().errors, 1); assert.equal(loop.stats().running, true);
});

test('onFrame 예외도 루프를 멈추지 않고, onError 가 던져도 계속 돈다', () => {
  const r = rig();
  const loop = createFrameLoop({ draw() {}, requestFrame: r.requestFrame, now: r.now,
    onFrame: () => { throw new Error('cb'); }, onError: () => { throw new Error('again'); } });
  loop.start(); r.step(); assert.equal(r.queued(), 1); assert.equal(loop.stats().errors, 1);
});

test('requestFrame 이 던지면 running=false 로 내려 start() 로 다시 켠다', () => {
  const r = rig(); let fail = true; const errs = [];
  const loop = createFrameLoop({ draw() {}, requestFrame: (cb) => { if (fail) throw new Error('rf'); r.requestFrame(cb); }, now: r.now,
    onError: (e, w) => errs.push(w) });
  loop.start(); assert.equal(loop.stats().running, false); assert.deepEqual(errs, ['requestFrame']);
  fail = false; loop.start(); assert.equal(loop.stats().running, true); assert.equal(r.queued(), 1);
});

test('frameMs 0·음수·NaN·Infinity·비숫자는 거부', () => {
  const base = { draw() {}, requestFrame() {}, now: () => 0 };
  for (const f of [0, -1, NaN, Infinity, '16']) assert.throws(() => createFrameLoop({ ...base, frameMs: f }), RangeError, String(f));
});

test('복호: postMessage 가 던지면 pending 0 으로 reject', async () => {
  const w = { postMessage() { throw new Error('clone'); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  await assert.rejects(c.decode(new Uint8Array(2)), /clone/);
  assert.equal(c.stats().pending, 0);
});

test('복호: terminate 뒤 decode 는 즉시 reject 하고 postMessage 하지 않는다', async () => {
  let posts = 0; const w = { postMessage() { posts++; }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const before = c.decode(new Uint8Array(1)); c.terminate();
  await assert.rejects(before, /terminated/);
  await assert.rejects(c.decode(new Uint8Array(1)), /terminated/);
  assert.equal(posts, 1); assert.equal(c.stats().pending, 0);
});

test('복호: ev.data 가 null 이어도 던지지 않고 대기 항목은 유지', () => {
  const w = { postMessage() {}, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  c.decode(new Uint8Array(1));
  assert.doesNotThrow(() => w.onmessage({ data: null }));
  assert.doesNotThrow(() => w.onmessage(null));
  assert.equal(c.stats().pending, 1);
});

test('복호: subarray 뷰는 범위만 복사해 넘기고 원본 버퍼는 건드리지 않는다', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const big = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  c.decode(big.subarray(2, 5));
  const [m, tr] = sent[0];
  assert.deepEqual([...m.bytes], [3, 4, 5]); assert.equal(m.bytes.buffer.byteLength, 3);
  assert.equal(tr[0], m.bytes.buffer); assert.notEqual(tr[0], big.buffer);
  assert.equal(big.buffer.byteLength, 8);
  const whole = new Uint8Array([9, 9]); c.decode(whole);
  assert.equal(sent[1][1][0], whole.buffer); // 전체 뷰는 복사 없이 그대로 넘긴다
});

test('now 가 한 번 던져도 errors+1·다음 프레임 예약·running 유지, start() 동작', () => {
  const r = rig(); let fail = 1; const errs = [];
  const loop = createFrameLoop({ draw() {}, requestFrame: r.requestFrame, now: () => { if (fail-- > 0) throw new Error('clock'); return r.now(); },
    onError: (e, w) => errs.push(w) });
  loop.start(); r.step();
  assert.deepEqual(errs, ['now']); assert.equal(loop.stats().errors, 1);
  assert.equal(loop.stats().running, true); assert.equal(r.queued(), 1);
  loop.start(); assert.equal(r.queued(), 1); // 이미 도는 중이라 중복 예약 없음
  r.step(); assert.equal(loop.stats().frames, 1); assert.equal(loop.stats().draws, 1);
});

test('복호: messageerror 뒤 pending 0·모든 decode reject', async () => {
  const w = { postMessage() {}, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const a = c.decode(new Uint8Array(1)), b = c.decode(new Uint8Array(1));
  assert.equal(c.stats().pending, 2);
  w.onmessageerror({});
  await assert.rejects(a, /messageerror/); await assert.rejects(b, /messageerror/);
  assert.equal(c.stats().pending, 0);
});

test('복호: timeoutMs 안에 응답이 없으면 그 요청만 reject, 응답이 오면 타이머 해제', async () => {
  const timers = new Map(); let nid = 1;
  const setTimeoutFn = (f, ms) => { timers.set(nid, { f, ms }); return nid++; };
  const clearTimeoutFn = (id) => { timers.delete(id); };
  const w = { postMessage() {}, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w, timeoutMs: 500, setTimeoutFn, clearTimeoutFn });
  const a = c.decode(new Uint8Array(1)), b = c.decode(new Uint8Array(1));
  assert.equal(timers.size, 1); assert.equal([...timers.values()][0].ms, 500);
  w.onmessage({ data: { id: 2, result: 'ok' } }); assert.equal(await b, 'ok'); assert.equal(timers.size, 1);
  [...timers.values()][0].f();
  await assert.rejects(a, /timeout/); assert.equal(c.stats().pending, 0);
  assert.throws(() => createDecodeWorkerClient({ spawn: () => w, timeoutMs: 0 }), RangeError);
});

test('복호: 응답 result 는 그대로 전달하고, message 없는 오류 객체도 [object Object] 가 되지 않는다', async () => {
  const w = { postMessage() {}, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const result = { planes: new ArrayBuffer(4), gpu: { format: 1, count: 0 } };
  const a = c.decode(new Uint8Array(1)); w.onmessage({ data: { id: 1, result } });
  assert.equal(await a, result);
  const b = c.decode(new Uint8Array(1)); w.onmessage({ data: { id: 2, error: { code: 7 } } });
  await assert.rejects(b, (e) => e.message === '{"code":7}');
});

test('복호: 전체 버퍼 bytes 는 transfer 로 소유권이 넘어가 호출자 쪽이 detach 된다(문서화된 동작)', () => {
  const w = { postMessage(m, tr) { for (const b of tr) structuredClone(b, { transfer: [b] }); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const bytes = new Uint8Array([1, 2]); c.decode(bytes);
  assert.equal(bytes.byteLength, 0);
});
