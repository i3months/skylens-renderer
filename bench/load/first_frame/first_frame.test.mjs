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

test('n=15 nearest-rank: p50 = 8th, p95 = 15th smallest (ceil, not round)', () => {
  // ceil(0.5*15)=8, ceil(0.95*15)=15; round would give 8 and 14.
  const times = [1500, 300, 1200, 900, 100, 1400, 700, 500, 1100, 200, 1300, 600, 1000, 400, 800];
  const s = firstFrameStats(log(times), 15);
  assert.deepEqual(s.perClientMs, times);
  assert.equal(s.p50Ms, 800);
  assert.equal(s.p95Ms, 1500);
});

test('zero first frames: NaN percentiles and a violation', () => {
  const none = firstFrameStats(log([null, null, null]), 3);
  assert.ok(Number.isNaN(none.p50Ms));
  assert.ok(Number.isNaN(none.p95Ms));
  assert.deepEqual(none.perClientMs, [Infinity, Infinity, Infinity]);
  assert.equal(firstFrameViolations(none).length, 1);
  const empty = firstFrameStats([], 2);
  assert.ok(Number.isNaN(empty.p95Ms));
  assert.equal(firstFrameViolations(empty).length, 1);
});

test('first_frame before the client connect gives Infinity, not a negative value', () => {
  const ev = [
    { id: 0, tMs: 1000, kind: 'connect' }, { id: 0, tMs: 400, kind: 'first_frame' },
    { id: 1, tMs: 0, kind: 'connect' }, { id: 1, tMs: 700, kind: 'first_frame' },
  ];
  const s = firstFrameStats(ev, 2);
  assert.deepEqual(s.perClientMs, [Infinity, 700]);
  assert.equal(s.p95Ms, Infinity);
  assert.equal(firstFrameViolations(s).length, 1);
});

test('clients must be an integer in 1..30', () => {
  for (const bad of [0, -1, 31, 1e9, 2.5, NaN, Infinity, '3', undefined, null]) {
    assert.throws(() => firstFrameStats([], bad), RangeError, String(bad));
  }
  assert.doesNotThrow(() => firstFrameStats(log([100]), 1));
  assert.doesNotThrow(() => firstFrameStats(log(Array(30).fill(100)), 30));
});

test('events must be an array', () => {
  assert.throws(() => firstFrameStats(undefined, 1), Error);
  assert.throws(() => firstFrameStats(null, 1), Error);
  assert.throws(() => firstFrameStats({}, 1), Error);
  assert.throws(() => firstFrameStats('events', 1), Error);
  assert.throws(() => firstFrameStats(42, 1), Error);
});

test('events array must not contain null', () => {
  const withNull = [{ id: 0, tMs: 0, kind: 'connect' }, null, { id: 0, tMs: 100, kind: 'first_frame' }];
  assert.throws(() => firstFrameStats(withNull, 1), /events array contains null/);
});

test('clients > MAX_CLIENTS throws', () => {
  assert.throws(() => firstFrameStats([], 31), RangeError);
});

test('clients = MAX_CLIENTS ok', () => {
  assert.doesNotThrow(() => firstFrameStats(log(Array(30).fill(100)), 30));
});

test('undefined event is rejected like null, with an Error not a TypeError', () => {
  for (const bad of [undefined, null]) {
    assert.throws(() => firstFrameStats([bad], 1), (e) => e instanceof Error && !(e instanceof TypeError));
  }
});

test('firstFrameViolations reports invalid stats input, not "p95 undefined"', () => {
  for (const bad of [{}, { p95Ms: undefined }, { p95Ms: '10' }, null, undefined]) {
    const v = firstFrameViolations(bad);
    assert.equal(v.length, 1);
    assert.match(v[0], /input invalid/);
    assert.doesNotMatch(v[0], /undefined/);
  }
});
