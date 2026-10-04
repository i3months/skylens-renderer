import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecodeWorkerClient } from './index.mjs';

function fakeWorker() {
  const w = { onmessage: null, onerror: null, onmessageerror: null, sent: [],
    postMessage(m) { w.sent.push(m); },
    terminate() { w.dead = true; } };
  w.reply = (data) => { w.onmessage({ data }); };
  w.replyError = (e) => { w.onerror(e); };
  w.replyMessageError = () => { w.onmessageerror(); };
  return w;
}

test('now throws in onmessage handler: resolve still executes, promise resolves, pending becomes 0', async () => {
  const w = fakeWorker();
  let callCount = 0;
  const now = () => { if (++callCount > 2) throw new Error('clock'); return callCount; };

  const c = createDecodeWorkerClient({ spawn: () => w, now });
  const p = c.decode(new Uint8Array([1, 2, 3]));

  assert.equal(c.stats().pending, 1);
  assert.equal(callCount, 2);

  w.reply({ id: w.sent[0].id, result: 'success' });

  assert.equal(await p, 'success');
  assert.equal(c.stats().pending, 0);
  assert.equal(c.stats().responses, 1);
});

test('now throws in onmessage with error: reject still executes, pending becomes 0', async () => {
  const w = fakeWorker();
  let callCount = 0;
  const now = () => { if (++callCount > 2) throw new Error('clock'); return callCount; };

  const c = createDecodeWorkerClient({ spawn: () => w, now });
  const p = c.decode(new Uint8Array([1]));

  assert.equal(c.stats().pending, 1);

  w.reply({ id: w.sent[0].id, error: 'decode failed' });

  await assert.rejects(p, /decode failed/);
  assert.equal(c.stats().pending, 0);
  assert.equal(c.stats().errors, 1);
});

test('now throws in onerror handler: failAll still executes, all pending rejected', async () => {
  const w = fakeWorker();
  let callCount = 0;
  const now = () => { if (++callCount > 2) throw new Error('clock'); return callCount; };

  const c = createDecodeWorkerClient({ spawn: () => w, now });
  const p1 = c.decode(new Uint8Array([1]));
  const p2 = c.decode(new Uint8Array([2]));

  assert.equal(c.stats().pending, 2);

  w.replyError(new Error('worker died'));

  await assert.rejects(p1, /worker died/);
  await assert.rejects(p2, /worker died/);
  assert.equal(c.stats().pending, 0);
});

test('now throws in onmessageerror handler: failAll still executes, all pending rejected', async () => {
  const w = fakeWorker();
  let callCount = 0;
  const now = () => { if (++callCount > 2) throw new Error('clock'); return callCount; };

  const c = createDecodeWorkerClient({ spawn: () => w, now });
  const p1 = c.decode(new Uint8Array([1]));
  const p2 = c.decode(new Uint8Array([2]));

  assert.equal(c.stats().pending, 2);

  w.replyMessageError();

  await assert.rejects(p1, /messageerror/);
  await assert.rejects(p2, /messageerror/);
  assert.equal(c.stats().pending, 0);
});
