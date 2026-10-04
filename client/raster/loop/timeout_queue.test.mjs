// timeoutMs 는 Worker 큐 대기가 아니라 처리 시작부터 잰다. 가짜 타이머·가짜 시계로 결정적.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecodeWorkerClient } from './index.mjs';

function fakeClock() {
  let t = 0, nid = 1; const timers = new Map();
  return {
    setTimeoutFn: (f, ms) => { const id = nid++; timers.set(id, { f, at: t + ms }); return id; },
    clearTimeoutFn: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let best = null;
        for (const [id, x] of timers) if (x.at <= end && (!best || x.at < best[1].at)) best = [id, x];
        if (!best) break;
        timers.delete(best[0]); t = Math.max(t, best[1].at); best[1].f();
      }
      t = end;
    },
  };
}

function rig(timeoutMs) {
  const clock = fakeClock(); const queue = [];
  const w = { postMessage(m) { queue.push(m.id); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w, timeoutMs, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
  // 워커는 응답당 perMs 걸리고 앞 요청부터 하나씩 처리한다.
  const respond = () => { const id = queue.shift(); w.onmessage({ data: { id, result: id } }); };
  return { c, clock, queue, respond, w };
}

test('응답당 100ms, 요청 20개, timeoutMs 500 이어도 timeout 0', async () => {
  const { c, clock, respond } = rig(500);
  const results = Array.from({ length: 20 }, () => c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message));
  for (let i = 0; i < 20; i++) { clock.advance(100); respond(); }
  const r = await Promise.all(results);
  assert.equal(r.filter((x) => x === 'timeout').length, 0);
  assert.equal(r.filter((x) => x === 'ok').length, 20);
  assert.equal(c.stats().pending, 0);
});

test('맨 앞 요청이 시한을 넘기면 Worker 가 막힌 것으로 보고 뒤 요청도 함께 거부한다(연쇄 오탐 대신 명시적 failAll)', async () => {
  // A 는 150 ms, B 는 80 ms 걸리는 입력, timeoutMs 100: B 는 A 가 버려진 직후 시작한 타이머로 따로 죽지 않는다.
  const { c, clock, queue, respond } = rig(100);
  const a = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  const b = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  clock.advance(99);
  assert.equal(c.stats().pending, 2);
  clock.advance(1);
  assert.equal(await a, 'timeout');
  assert.match(await b, /timeout/);
  assert.equal(c.stats().pending, 0);
  // 버려진 id 의 늦은 응답은 무시되고 던지지 않는다.
  assert.doesNotThrow(() => { respond(); respond(); });
  assert.equal(queue.length, 0);
  assert.equal(c.stats().responses, 0);
});

test('시한 뒤 새 요청도 다시 맨 앞이 되어 자기 시한을 받는다(order 에 유령이 남지 않는다)', async () => {
  const { c, clock } = rig(100);
  const a = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  clock.advance(100);
  assert.equal(await a, 'timeout');
  const b = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  clock.advance(99);
  assert.equal(c.stats().pending, 1);
  clock.advance(1);
  assert.equal(await b, 'timeout');
  assert.equal(c.stats().pending, 0);
});

test('앞 요청이 응답하면 뒤 요청은 그 시점부터 시한을 잰다', async () => {
  const { c, clock, respond } = rig(100);
  const a = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  const b = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  clock.advance(90); respond();
  assert.equal(await a, 'ok');
  clock.advance(99);
  assert.equal(c.stats().pending, 1);
  clock.advance(1);
  assert.equal(await b, 'timeout');
});

test('setTimeoutFn 이 던지면 그 요청은 던진 오류로 settle 하고 pending 에 남지 않으며 이후 요청도 막히지 않는다', async () => {
  const clock = fakeClock(); let fail = true; const posts = [];
  const w = { postMessage(m) { posts.push(m.id); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w, timeoutMs: 100,
    setTimeoutFn: (f, ms) => { if (fail) throw new Error('timer'); return clock.setTimeoutFn(f, ms); },
    clearTimeoutFn: clock.clearTimeoutFn });
  await assert.rejects(c.decode(new Uint8Array(1)), /timer/);
  assert.equal(c.stats().pending, 0);
  assert.equal(posts.length, 0);
  fail = false;
  const b = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  clock.advance(100); // order 에 유령이 남았다면 b 에 타이머가 걸리지 않아 영원히 미결이다
  assert.equal(await b, 'timeout');
  assert.equal(c.stats().pending, 0);
});

test('다음 요청 타이머 설정이 던져도 앞 요청은 이미 resolve 되고 던진 요청은 reject, 그 뒤 요청이 시한을 받는다', async () => {
  const clock = fakeClock(); let calls = 0; const q = [];
  const w = { postMessage(m) { q.push(m.id); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w, timeoutMs: 100,
    setTimeoutFn: (f, ms) => { if (++calls === 2) throw new Error('timer2'); return clock.setTimeoutFn(f, ms); },
    clearTimeoutFn: clock.clearTimeoutFn });
  const a = c.decode(new Uint8Array(1)); // 타이머 1
  const b = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  const d = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  w.onmessage({ data: { id: q[0], result: 'A' } }); // b 의 타이머(2번째 호출)가 던진다 -> d 가 맨 앞이 되어 타이머 3
  assert.equal(await a, 'A');
  assert.equal(await b, 'timer2');
  assert.equal(c.stats().pending, 1);
  clock.advance(100);
  assert.equal(await d, 'timeout');
  assert.equal(c.stats().pending, 0);
});

test('postMessage 가 던지면 맨 앞 항목을 대기열에서도 빼서 다음 요청이 시한을 받는다', async () => {
  const clock = fakeClock(); let first = true;
  const w = { postMessage() { if (first) { first = false; throw new Error('clone'); } }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w, timeoutMs: 100, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
  await assert.rejects(c.decode(new Uint8Array(1)), /clone/);
  const b = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  clock.advance(100);
  assert.equal(await b, 'timeout');
});

test('failAll(messageerror) 뒤 대기열이 비어 새 요청이 시한을 받는다', async () => {
  const { c, clock, w } = rig(100);
  const a = c.decode(new Uint8Array(1)).catch((e) => e.message);
  const b = c.decode(new Uint8Array(1)).catch((e) => e.message);
  w.onmessageerror({});
  assert.equal(await a, 'messageerror'); assert.equal(await b, 'messageerror');
  const d = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  clock.advance(100); // 유령 항목이 남았다면 d 는 맨 앞이 아니라 타이머가 없어 미결이다
  assert.equal(await d, 'timeout');
});
