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
  w.reply = (data) => { r.advance(costMs); w.onmessage({ data }); };
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
