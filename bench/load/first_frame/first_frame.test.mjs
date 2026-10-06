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
    if (t !== null) {
      ev.push({ id, tMs: c + t, kind: 'level', level: 0 });
      ev.push({ id, tMs: c + t, kind: 'first_frame' });
    }
  });
  return ev;
}

test('limit constant is 3000 ms', () => {
  assert.equal(FIRST_FRAME_P95_LIMIT_MS, 3000);
});

test('FIXTURE_EVENTS: every client has a first frame, p95 matches the contract comment', () => {
  const s = firstFrameStats(FIXTURE_EVENTS, 3);
  assert.deepEqual(s.perClientMs, [1200, 2000, 2800]);
  assert.deepEqual(s.missing, []);
  assert.deepEqual(s.noArrival, []);
  assert.equal(s.p50Ms, 2000);
  assert.equal(s.p95Ms, 2800);
  assert.deepEqual(firstFrameViolations(s), []);
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
    { id: 0, tMs: 2500, kind: 'level', level: 0 },
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
  assert.deepEqual(firstFrameViolations(s2), ['client 18: no first frame', 'client 19: no first frame']);
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
  assert.deepEqual(firstFrameViolations(none), [
    'first-frame p95 is NaN: no first frame was measured',
    'client 0: no first frame', 'client 1: no first frame', 'client 2: no first frame',
  ]);
  const empty = firstFrameStats([], 2);
  assert.ok(Number.isNaN(empty.p95Ms));
  assert.deepEqual(firstFrameViolations(empty), [
    'first-frame p95 is NaN: no first frame was measured', 'client 0: no first frame', 'client 1: no first frame',
  ]);
});

test('first_frame before the client connect gives Infinity, not a negative value', () => {
  const ev = [
    { id: 0, tMs: 1000, kind: 'connect' }, { id: 0, tMs: 300, kind: 'level', level: 0 }, { id: 0, tMs: 400, kind: 'first_frame' },
    { id: 1, tMs: 0, kind: 'connect' }, { id: 1, tMs: 700, kind: 'level', level: 0 }, { id: 1, tMs: 700, kind: 'first_frame' },
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

test('30 clients, client 5 has no first_frame: p95 is finite but exactly one violation is reported', () => {
  const times = Array.from({ length: 30 }, (_, i) => 100 + i * 10);
  times[5] = null;
  const s = firstFrameStats(log(times), 30);
  assert.ok(Number.isFinite(s.p95Ms));
  assert.deepEqual(s.missing, [5]);
  assert.deepEqual(firstFrameViolations(s), ['client 5: no first frame']);
});

test('missing lists every client without a first frame, in id order; healthy log has none', () => {
  const s = firstFrameStats(log([100, null, 200, null, 300]), 5);
  assert.deepEqual(s.missing, [1, 3]);
  assert.deepEqual(firstFrameViolations(s), ['client 1: no first frame', 'client 3: no first frame']);
  const ok = firstFrameStats(log(Array(30).fill(100)), 30);
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(firstFrameViolations(ok), []);
});

test('slow p95 with a missing client reports both; all missing keeps the NaN message', () => {
  const times = Array(30).fill(4000);
  times[0] = null;
  assert.deepEqual(firstFrameViolations(firstFrameStats(log(times), 30)),
    ['first-frame p95 4000 ms exceeds limit 3000 ms', 'client 0: no first frame']);
  assert.deepEqual(firstFrameViolations(firstFrameStats(log([null, null]), 2)),
    ['first-frame p95 is NaN: no first frame was measured', 'client 0: no first frame', 'client 1: no first frame']);
});

test('F-544: first_frame without a level-0 arrival is Infinity and reported', () => {
  const s = firstFrameStats([{ id: 0, tMs: 0, kind: 'connect' }, { id: 0, tMs: 500, kind: 'first_frame' }], 1);
  assert.deepEqual(s.perClientMs, [Infinity]);
  assert.deepEqual(s.missing, [0]);
  assert.deepEqual(firstFrameViolations(s), [
    'first-frame p95 is NaN: no first frame was measured',
    'client 0: first_frame without level-0 arrival',
  ]);
});

test('F-544: a level arriving after the first_frame, or no level at all, does not count', () => {
  const ev = [
    { id: 0, tMs: 0, kind: 'connect' }, { id: 0, tMs: 600, kind: 'level', level: 1 }, { id: 0, tMs: 500, kind: 'first_frame' },
    { id: 1, tMs: 0, kind: 'connect' }, { id: 1, tMs: 600, kind: 'level', level: 0 }, { id: 1, tMs: 500, kind: 'first_frame' },
    { id: 2, tMs: 0, kind: 'connect' }, { id: 2, tMs: 500, kind: 'level', level: 0 }, { id: 2, tMs: 500, kind: 'first_frame' },
    { id: 3, tMs: 0, kind: 'connect' },
  ];
  const s = firstFrameStats(ev, 4);
  assert.deepEqual(s.perClientMs, [Infinity, Infinity, 500, Infinity]);
  assert.deepEqual(s.missing, [0, 1, 3]);
  assert.deepEqual(firstFrameViolations(s).filter((v) => v.startsWith('client')), [
    'client 0: first_frame without level-0 arrival',
    'client 1: first_frame without level-0 arrival',
    'client 3: no first frame',
  ]);
});

test('F-544: a later first_frame with an arrival counts; a level of another id does not', () => {
  const ev = [
    { id: 0, tMs: 0, kind: 'connect' }, { id: 0, tMs: 100, kind: 'first_frame' },
    { id: 0, tMs: 300, kind: 'level', level: 0 }, { id: 0, tMs: 400, kind: 'first_frame' },
    { id: 1, tMs: 0, kind: 'connect' }, { id: 1, tMs: 100, kind: 'first_frame' },
  ];
  assert.deepEqual(firstFrameStats(ev, 2).perClientMs, [400, Infinity]);
});

test('F-548: violations derive missing from perClientMs when stats carry no missing list', () => {
  assert.deepEqual(firstFrameViolations({ p95Ms: 100, perClientMs: [100, Infinity, 50, NaN] }),
    ['client 1: no first frame', 'client 3: no first frame']);
  assert.deepEqual(firstFrameViolations({ p95Ms: 100, perClientMs: [100, 50] }), []);
});

test('F-553: first_frame before level-0 arrival is reported even when a later one is valid', () => {
  const ev = [
    { id: 0, tMs: 0, kind: 'connect' }, { id: 0, tMs: 400, kind: 'first_frame' },
    { id: 0, tMs: 450, kind: 'level', level: 0 }, { id: 0, tMs: 500, kind: 'first_frame' },
  ];
  const s = firstFrameStats(ev, 1);
  assert.deepEqual(s.perClientMs, [500]);
  assert.deepEqual(firstFrameViolations(s), ['client 0: first_frame before level-0 arrival (out of order)']);
});

test('F-553: first_frame before connect reports order, not "no first frame"', () => {
  const ev = [{ id: 0, tMs: 1000, kind: 'connect' }, { id: 0, tMs: 500, kind: 'first_frame' }];
  const v = firstFrameViolations(firstFrameStats(ev, 1));
  assert.ok(v.length >= 1);
  assert.ok(v.includes('client 0: first_frame before connect (out of order)'));
  assert.ok(v.every((m) => !/no first frame$/.test(m)));
});

test('F-553: unsorted level-0 arrivals, the earliest one counts', () => {
  const ev = [
    { id: 0, tMs: 0, kind: 'connect' }, { id: 0, tMs: 600, kind: 'level', level: 0 },
    { id: 0, tMs: 100, kind: 'level', level: 0 }, { id: 0, tMs: 500, kind: 'first_frame' },
  ];
  const s = firstFrameStats(ev, 1);
  assert.deepEqual(s.perClientMs, [500]);
  assert.deepEqual(firstFrameViolations(s), []);
});

test('F-556: any level arrival at or before first_frame accepts it; later level 0 is irrelevant', () => {
  const ev = [
    { id: 0, tMs: 0, kind: 'connect' }, { id: 0, tMs: 500, kind: 'level', level: 1 },
    { id: 0, tMs: 500, kind: 'first_frame' }, { id: 0, tMs: 900, kind: 'level', level: 0 },
  ];
  const s = firstFrameStats(ev, 1);
  assert.deepEqual(s.perClientMs, [500]);
  assert.equal(s.p95Ms, 500);
  assert.deepEqual(s.outOfOrder, []);
  assert.deepEqual(firstFrameViolations(s), []);
});

test('F-560: firstFrameViolations accepts valid minimal stats', () => {
  assert.deepEqual(firstFrameViolations({ p95Ms: 100, missing: [] }), []);
  assert.deepEqual(firstFrameViolations({ p95Ms: 100, perClientMs: [1, 2] }), []);
  assert.deepEqual(firstFrameViolations({ p95Ms: 100, missing: [], outOfOrder: [] }), []);
});

test('F-563: malformed stats yield violations and never throw', () => {
  const cases = [
    { p95Ms: 100 },
    { p95Ms: 1, missing: 'abc' },
    { p95Ms: 1, perClientMs: 'abc' },
    { p95Ms: 1, outOfOrder: 'abc' },
    { p95Ms: 1, outOfOrder: [{}] },
    { p95Ms: 1, outOfOrder: [null] },
    { p95Ms: 1, missing: [], outOfOrder: [null] },
  ];
  for (const c of cases) {
    let v;
    assert.doesNotThrow(() => { v = firstFrameViolations(c); }, JSON.stringify(c));
    assert.ok(v.length >= 1, JSON.stringify(c));
  }
});

test('F-563: a valid firstFrameStats result still gives no violations', () => {
  assert.deepEqual(firstFrameViolations(firstFrameStats(log([100, 200]), 2)), []);
});

test('F-563: an explicit missing list takes priority over perClientMs', () => {
  assert.deepEqual(firstFrameViolations({ p95Ms: 100, missing: [2] }), ['client 2: no first frame']);
  assert.deepEqual(firstFrameViolations({ p95Ms: 100, missing: [2], perClientMs: [1, 1, 1] }), ['client 2: no first frame']);
  assert.deepEqual(firstFrameViolations({ p95Ms: 100, missing: [], perClientMs: [1, Infinity] }), []);
});

test('F-563: a level event without a valid level 0..3 is not an arrival', () => {
  for (const lv of [{}, { level: 99 }, { level: -1 }, { level: 1.5 }, { level: '0' }, { level: 4 }]) {
    const ev = [
      { id: 0, tMs: 0, kind: 'connect' },
      { id: 0, tMs: 100, kind: 'level', ...lv },
      { id: 0, tMs: 100, kind: 'first_frame' },
    ];
    const s = firstFrameStats(ev, 1);
    assert.deepEqual(s.perClientMs, [Infinity], JSON.stringify(lv));
    assert.deepEqual(s.noArrival, [0]);
    assert.ok(firstFrameViolations(s).includes('client 0: first_frame without level-0 arrival'), JSON.stringify(lv));
  }
  const ok = firstFrameStats([
    { id: 0, tMs: 0, kind: 'connect' }, { id: 0, tMs: 100, kind: 'level', level: 3 }, { id: 0, tMs: 100, kind: 'first_frame' },
  ], 1);
  assert.deepEqual(ok.perClientMs, [100]);
});

test('F-560: connect uses the minimum tMs, not the first value seen', () => {
  const ev = [
    { id: 0, tMs: 400, kind: 'connect' }, { id: 0, tMs: 100, kind: 'connect' },
    { id: 0, tMs: 700, kind: 'level', level: 0 }, { id: 0, tMs: 700, kind: 'first_frame' },
  ];
  assert.deepEqual(firstFrameStats(ev, 1).perClientMs, [600]);
});

test('F-568: outOfOrder reasons are pinned', () => {
  const ev = [
    { id: 0, tMs: 100, kind: 'connect' }, { id: 0, tMs: 50, kind: 'first_frame' }, { id: 0, tMs: 60, kind: 'level', level: 0 },
    { id: 1, tMs: 0, kind: 'connect' }, { id: 1, tMs: 50, kind: 'first_frame' }, { id: 1, tMs: 60, kind: 'level', level: 0 },
    { id: 2, tMs: 0, kind: 'connect' }, { id: 2, tMs: 50, kind: 'first_frame' }, { id: 2, tMs: 50, kind: 'level', level: 2 },
  ];
  assert.deepEqual(firstFrameStats(ev, 3).outOfOrder, [
    { id: 0, reason: 'before_connect' }, { id: 1, reason: 'before_firstArrival' },
  ]);
});

test('F-568: unknown outOfOrder reason is a violation', () => {
  const v = firstFrameViolations({ p95Ms: 1, missing: [], outOfOrder: [{ id: 0, reason: 'before_level0' }] });
  assert.ok(v.length >= 1);
});

test('F-571: noArrival of wrong type is a violation', () => {
  assert.ok(firstFrameViolations({ p95Ms: 1, missing: [], perClientMs: [1], noArrival: 'x' }).length >= 1);
});
