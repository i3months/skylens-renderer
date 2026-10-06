import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_EVENTS } from '../../../contracts/load/harness.mjs';
import { firstFrameStats, firstFrameViolations, FIRST_FRAME_P95_LIMIT_MS } from './index.mjs';

// Builds a log where client i connects at connectMs[i] (default 0) and shows its first frame
// after times[i] ms; a null time means no first_frame event.
function log(times, connectMs = []) {
  const ev = [];
  times.forEach((t, id) => {
    const c = connectMs[id] ?? 0;
    ev.push({ id, tMs: c, kind: 'connect' });
    if (t !== null) ev.push({ id, tMs: c + t, kind: 'first_frame' });
  });
  return ev;
}

test('limit constant is 3000 ms', () => {
  assert.equal(FIRST_FRAME_P95_LIMIT_MS, 3000);
});

test('FIXTURE_EVENTS: Infinity for the client without a first frame', () => {
  const s = firstFrameStats(FIXTURE_EVENTS, 3);
  assert.deepEqual(s.perClientMs, [1200, 2000, Infinity]);
  assert.equal(s.p50Ms, 2000);
  assert.equal(s.p95Ms, Infinity);
  assert.equal(firstFrameViolations(s).length, 1);
});

test('20 clients, nearest-rank p50 = 10th and p95 = 19th smallest', () => {
  // Shuffled 100..2000 step 100.
  const times = [1100, 300, 2000, 700, 1500, 100, 1900, 900, 500, 1300,
    200, 1800, 600, 1000, 1700, 400, 1200, 800, 1600, 1400];
  const s = firstFrameStats(log(times), 20);
  assert.deepEqual(s.perClientMs, times);
  assert.equal(s.p50Ms, 1000);
  assert.equal(s.p95Ms, 1900);
  assert.deepEqual(firstFrameViolations(s), []);
});

test('connect time is subtracted; first of several first_frame events counts', () => {
  const ev = [
    { id: 0, tMs: 500, kind: 'connect' },
    { id: 0, tMs: 2500, kind: 'first_frame' },
    { id: 0, tMs: 3000, kind: 'first_frame' },
  ];
  assert.deepEqual(firstFrameStats(ev, 1).perClientMs, [2000]);
});

test('one missing client of 20 leaves p95 finite; two missing push p95 to Infinity', () => {
  const base = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
  const one = base.slice(); one[19] = null;
  const s1 = firstFrameStats(log(one), 20);
  assert.equal(s1.perClientMs[19], Infinity);
  assert.equal(s1.p50Ms, 1000);
  assert.equal(s1.p95Ms, 1900);
  const two = one.slice(); two[18] = null;
  const s2 = firstFrameStats(log(two), 20);
  assert.equal(s2.p50Ms, 1000);
  assert.equal(s2.p95Ms, Infinity);
  assert.equal(firstFrameViolations(s2).length, 1);
});

test('boundary: p95 exactly 3000 passes, 3001 fails', () => {
  const mk = (p95) => {
    const t = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    t[18] = p95; // the 19th smallest (ceil(0.95*20)); only t[19] is larger
    t[19] = p95 + 1000;
    return t;
  };
  const ok = firstFrameStats(log(mk(3000)), 20);
  assert.equal(ok.p95Ms, 3000);
  assert.deepEqual(firstFrameViolations(ok), []);
  const bad = firstFrameStats(log(mk(3001)), 20);
  assert.equal(bad.p95Ms, 3001);
  assert.equal(firstFrameViolations(bad).length, 1);
});
