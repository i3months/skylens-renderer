// onmessageerror 뒤에는 Worker 를 terminated 로 세워, 버려진 요청 처리 중인 Worker 에 새 시한이 걸려 거짓 timeout 이 나지 않게 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecodeWorkerClient } from './index.mjs';

function rig(timeoutMs) {
  let nid = 1; const timers = new Map(); let terminateCalls = 0;
  const w = { postMessage() {}, terminate() { terminateCalls++; } };
  const c = createDecodeWorkerClient({
    spawn: () => w, timeoutMs,
    setTimeoutFn: (f, ms) => { const id = nid++; timers.set(id, { f, ms }); return id; },
    clearTimeoutFn: (id) => { timers.delete(id); },
  });
  return { c, w, timers, terminates: () => terminateCalls };
}

test('messageerror 뒤 decode 는 즉시 terminated 로 거부되고 시한 타이머가 걸리지 않는다', async () => {
  const { c, w, timers, terminates } = rig(100);
  const p1 = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  const p2 = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  w.onmessageerror({});
  assert.equal(await p1, 'messageerror');
  assert.equal(await p2, 'messageerror');
  assert.equal(terminates(), 1);
  const p3 = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  assert.equal(await p3, 'terminated');
  assert.equal(timers.size, 0);
  const s = c.stats();
  assert.equal(s.pending, 0);
  assert.equal(s.requests, s.responses + s.errors + s.pending);
});

test('messageerror 뒤 terminate() 를 불러도 stats 항등식이 유지된다', async () => {
  const { c, w } = rig(100);
  const p = c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  w.onmessageerror({});
  await p;
  c.terminate();
  await c.decode(new Uint8Array(1)).then(() => 'ok', (e) => e.message);
  const s = c.stats();
  assert.equal(s.requests, s.responses + s.errors + s.pending);
});
