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
  return { c, clock, queue, respond };
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

test('응답이 정말 없는 요청은 처리 시작 후 timeoutMs 가 지나면 timeout, 뒤 요청은 그때부터 잰다', async () => {
  const { c, clock, respond } = rig(500);
  const a = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  const b = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  clock.advance(499);
  assert.equal(c.stats().pending, 2);
  clock.advance(1);
  assert.equal(await a, 'timeout');
  assert.equal(c.stats().pending, 1);
  clock.advance(499); // b 는 a 가 끝난 시점부터 재므로 아직 살아 있다
  assert.equal(c.stats().pending, 1);
  clock.advance(1);
  assert.equal(await b, 'timeout');
  assert.equal(c.stats().pending, 0);
  void respond;
});
