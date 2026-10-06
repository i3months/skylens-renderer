import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateBurst, checkBurstInvariants, showFromArrivals, burstArrivals } from './index.mjs';
import { simulateClients } from '../clients/index.mjs';
import { validateScenario } from '../../../contracts/load/index.mjs';

const mk = (burstLevels, clients = 30) => ({
  name: 'burst', kind: 'burst', clients, durationS: 10, burstLevels,
  path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: 10, e: 30, n: 0, u: 100 }],
});
const lv = (id, tMs, level) => ({ id, tMs, kind: 'level', level });
const at = (id, tMs, level) => ({ id, tMs, level });
// Drops the burst-completeness messages so a test can focus on the show/arrival checks of hand-built logs.
// It also asserts the completeness violations dropped: none by default, or exactly `expected` for deliberately partial logs.
const COMPLETENESS = /burst level|no burst arrivals|arrived more than once/;
const showOnly = (v, expected = []) => {
  assert.deepEqual(v.filter((m) => COMPLETENESS.test(m)), expected, 'completeness violations');
  return v.filter((m) => !COMPLETENESS.test(m));
};

test('scenario helper is valid', () => assert.deepEqual(validateScenario(mk(2)), []));

test('showFromArrivals: same-instant levels show only the highest one', () => {
  assert.deepEqual(showFromArrivals([lv(0, 100, 0), lv(0, 100, 1), lv(0, 100, 2), lv(0, 100, 3)], 1), [at(0, 100, 3)]);
  assert.deepEqual(showFromArrivals([lv(0, 100, 3), lv(0, 100, 0), lv(0, 100, 2), lv(0, 100, 1)], 1), [at(0, 100, 3)]);
});

test('showFromArrivals: overtaken later lower level is skipped', () => {
  assert.deepEqual(showFromArrivals([lv(0, 100, 0), lv(0, 200, 3), lv(0, 300, 1)], 1), [at(0, 100, 0), at(0, 200, 3)]);
  // unsorted input is ordered by tMs first
  assert.deepEqual(showFromArrivals([lv(0, 300, 1), lv(0, 200, 3), lv(0, 100, 0)], 1), [at(0, 100, 0), at(0, 200, 3)]);
});

test('showFromArrivals: rising levels replace, clients are independent, non-level events ignored', () => {
  const ev = [lv(1, 50, 2), lv(0, 100, 0), { id: 0, tMs: 120, kind: 'bytes', bytes: 9, latencyMs: 1 }, lv(0, 150, 1), lv(1, 150, 1), lv(0, 150, 2)];
  assert.deepEqual(showFromArrivals(ev, 2), [at(1, 50, 2), at(0, 100, 0), at(0, 150, 2)]);
});

test('checker: shown with no arrivals is a violation', () => {
  const v = checkBurstInvariants([], [at(0, 100, 1)], mk(4, 1));
  assert.ok(v.length >= 1);
  assert.ok(v.includes('client 0: level 1 at 100ms never arrived'));
});

test('checker: arrivals that are never shown is a violation', () => {
  const v = checkBurstInvariants([at(0, 100, 0), at(0, 100, 1), at(0, 100, 2), at(0, 100, 3)], [], mk(4, 1));
  assert.deepEqual(v, ['client 0: levels arrived but never shown']);
});

test('checker: missed replacement is a violation', () => {
  const v = showOnly(checkBurstInvariants([at(0, 100, 0), at(0, 101, 3)], [at(0, 100, 0)], mk(4, 1)),
    ['client 0: burst level 1 missing', 'client 0: burst level 2 missing', 'client 0: burst levels not at one instant']);
  assert.deepEqual(v, ['client 0: level 3 arrived at 101ms but was not shown']);
});

test('checker: decrease in unsorted shown input is caught after sorting', () => {
  const v = checkBurstInvariants([at(0, 200, 1), at(0, 100, 3)], [at(0, 200, 1), at(0, 100, 3)], mk(4, 1));
  assert.ok(v.includes('client 0: level 1 at 200ms shown after level 3'));
  assert.ok(v.includes('client 0: level 1 at 200ms shown while level 3 had arrived'));
});

test('checker: unsorted but valid input has no violations', () => {
  assert.deepEqual(showOnly(checkBurstInvariants([at(0, 200, 1), at(0, 100, 3)], [at(0, 100, 3)], mk(4, 1)),
    ['client 0: burst level 0 missing', 'client 0: burst level 2 missing', 'client 0: burst levels not at one instant']), []);
});

test('checker: shown before arrival is a violation', () => {
  const v = checkBurstInvariants([at(0, 200, 2)], [at(0, 100, 2)], mk(4, 1));
  assert.ok(v.includes('client 0: level 2 shown at 100ms before it arrived at 200ms'));
});

test('checker: lower level shown when a higher one had arrived', () => {
  const v = checkBurstInvariants([at(0, 100, 0), at(0, 100, 2)], [at(0, 100, 0)], mk(4, 1));
  assert.ok(v.includes('client 0: level 0 at 100ms shown while level 2 had arrived'));
});

test('checker: duplicate show at one instant is a violation', () => {
  const v = checkBurstInvariants([at(0, 100, 1)], [at(0, 100, 1), at(0, 100, 1)], mk(2, 1));
  assert.ok(v.includes('client 0: shown 2 times at 100ms'));
  const w = checkBurstInvariants([at(0, 100, 0), at(0, 100, 1)], [at(0, 100, 0), at(0, 100, 1)], mk(2, 1));
  assert.ok(w.includes('client 0: shown 2 times at 100ms'));
});

test('checker: out-of-range entries are violations', () => {
  const s = mk(4, 2);
  // client 1 is healthy so only the injected entry is reported
  const base = [at(1, 100, 1)];
  const miss = (id) => [0, 2, 3].map((k) => `client ${id}: burst level ${k} missing`);
  const partial = [...miss(0), ...miss(1)]; // both clients only carry level 1 of 0..3
  for (const level of [4, -1, 1.5, NaN]) {
    const v = showOnly(checkBurstInvariants([at(0, 100, 1), ...base], [at(0, 100, 1), at(0, 150, level), ...base], s), partial);
    assert.equal(v.length, 1, `level ${level}`);
    assert.match(v[0], /^shown: client 0 level .* out of range 0\.\.3$/);
  }
  for (const id of [2, -1, 0.5]) {
    assert.deepEqual(showOnly(checkBurstInvariants([at(0, 100, 1), ...base], [at(0, 100, 1), ...base, at(id, 100, 1)], s), partial), [`shown: id ${id} out of range 0..1`]);
  }
  assert.deepEqual(showOnly(checkBurstInvariants([at(0, 100, 1), ...base], [at(0, 100, 1), ...base, at(0, Infinity, 1)], s), partial), ['shown: client 0 tMs Infinity not finite']);
  assert.deepEqual(showOnly(checkBurstInvariants([at(0, 100, 7), ...base], [at(1, 100, 1)], s), ['client 0: no burst arrivals', ...miss(1)]),
    ['arrival: client 0 level 7 at 100ms out of range 0..3']);
});

test('checker: valid inputs have no violations', () => {
  const s = mk(4, 2);
  const arrivals = [at(0, 100, 0), at(0, 100, 1), at(0, 100, 2), at(0, 100, 3), at(1, 400, 0), at(1, 400, 1), at(1, 400, 2), at(1, 400, 3)];
  const shown = [at(0, 100, 3), at(1, 400, 3)];
  assert.deepEqual(checkBurstInvariants(arrivals, shown, s), []);
  assert.deepEqual(showFromArrivals(arrivals.map((a) => ({ ...a, kind: 'level' })), 2), shown);
});

test('checker: no burst arrivals at all is one violation per client in id order', () => {
  assert.deepEqual(checkBurstInvariants([], [], mk(2, 3)), ['client 0: no burst arrivals', 'client 1: no burst arrivals', 'client 2: no burst arrivals']);
  const r = simulateBurst(mk(2), { seed: 1 });
  const noLevels = checkBurstInvariants([], [], mk(2));
  assert.deepEqual(r.violations, []);
  assert.deepEqual(noLevels, Array.from({ length: 30 }, (_, id) => `client ${id}: no burst arrivals`));
});

test('checker: 30-client burst log with all level events removed reports every client', () => {
  const ev = simulateClients(mk(4), { seed: 3 }).filter((e) => e.kind !== 'level');
  const arrivals = burstArrivals(ev, 4);
  assert.deepEqual(arrivals, []);
  const shown = showFromArrivals(ev, 30);
  assert.deepEqual(shown, []);
  assert.deepEqual(checkBurstInvariants(arrivals, shown, mk(4)), Array.from({ length: 30 }, (_, id) => `client ${id}: no burst arrivals`));
});

test('checker: only client 7 missing from a healthy 30-client burst gives exactly one violation', () => {
  const r = simulateBurst(mk(4), { seed: 3 });
  const arrivals = r.arrivals.filter((a) => a.id !== 7);
  const shown = r.shown.filter((x) => x.id !== 7);
  assert.deepEqual(checkBurstInvariants(arrivals, shown, mk(4)), ['client 7: no burst arrivals']);
});

test('simulateBurst: shows come from the machine and pass the checker', () => {
  for (let b = 1; b <= 4; b++) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = simulateBurst(mk(b), { seed });
      assert.deepEqual(r.violations, []);
      assert.ok(r.arrivals.length >= 30 * b);
      assert.ok(r.arrivals.every((a) => a.level < b));
      for (let id = 0; id < 30; id++) {
        const mine = r.shown.filter((s) => s.id === id);
        assert.equal(mine.length, 1);
        assert.equal(mine[mine.length - 1].level, b - 1);
      }
    }
  }
});

test('simulateBurst: deterministic per seed, differs across seeds', () => {
  assert.deepEqual(simulateBurst(mk(4), { seed: 7 }), simulateBurst(mk(4), { seed: 7 }));
  assert.notDeepEqual(simulateBurst(mk(4), { seed: 7 }).shown, simulateBurst(mk(4), { seed: 8 }).shown);
});

test('simulateBurst: rejects non-burst and invalid scenarios', () => {
  assert.throws(() => simulateBurst({ ...mk(2), kind: 'steady' }, { seed: 1 }));
  assert.throws(() => simulateBurst({ ...mk(2), burstLevels: 5 }, { seed: 1 }));
  assert.throws(() => simulateBurst({ ...mk(2), clients: 0 }, { seed: 1 }));
});

test('showFromArrivals: ascending same-instant input still ends on the highest level of that instant', () => {
  // harness policy: the instant is re-ordered highest first before the machine sees it
  const shown = showFromArrivals([lv(0, 100, 0), lv(0, 100, 1), lv(0, 100, 2)], 1);
  assert.deepEqual(shown, [at(0, 100, 2)]);
});

test('showFromArrivals: a hand-built overtaken late lower level is never shown', () => {
  // The simulator itself never generates overtaking (burst levels share one instant); this log is hand built.
  const arrivals = [lv(0, 100, 2), lv(0, 200, 1)];
  const shown = showFromArrivals(arrivals, 1);
  assert.deepEqual(shown, [at(0, 100, 2)]);
  assert.deepEqual(showOnly(checkBurstInvariants(arrivals, shown, mk(4, 1)),
    ['client 0: burst level 0 missing', 'client 0: burst level 3 missing', 'client 0: burst levels not at one instant']), []);
  assert.ok(checkBurstInvariants(arrivals, [at(0, 100, 2), at(0, 200, 1)], mk(4, 1))
    .includes('client 0: level 1 at 200ms shown after level 2'));
});

test('burstArrivals: keeps level events below burstLevels, drops post-burst levels, keeps invalid ones', () => {
  const ev = [lv(0, 1, 0), lv(0, 1, 1), lv(0, 2, 2), lv(0, 3, 3), { id: 0, tMs: 4, kind: 'bytes' }, lv(0, 5, 1.5), lv(0, 6, 9)];
  assert.deepEqual(burstArrivals(ev, 2), [lv(0, 1, 0), lv(0, 1, 1), lv(0, 5, 1.5), lv(0, 6, 9)]);
  assert.deepEqual(burstArrivals(ev, 4).length, 6);
});

test('checker: clients validated, bad scenario/arrays throw a clear Error', () => {
  for (const clients of [0, 31, 1.5, NaN, undefined, '2']) {
    assert.throws(() => checkBurstInvariants([], [], { ...mk(2), clients }), (e) => e instanceof Error && !(e instanceof TypeError) && /clients/.test(e.message));
  }
  for (const sc of [undefined, null, 5]) {
    assert.throws(() => checkBurstInvariants([], [], sc), (e) => e.constructor === Error && /scenario/.test(e.message));
  }
  assert.throws(() => checkBurstInvariants(null, [], mk(2)), (e) => e.constructor === Error && /arrivals/.test(e.message));
  assert.throws(() => checkBurstInvariants([], {}, mk(2)), (e) => e.constructor === Error && /shown/.test(e.message));
});

test('checker: burstLevels outside 1..LEVEL_COUNT integer throws a clear Error', () => {
  for (const burstLevels of [0, 5, -1, 1.5, NaN, undefined, '2', null]) {
    assert.throws(() => checkBurstInvariants([], [], { ...mk(2), burstLevels }), (e) => e.constructor === Error && /burstLevels/.test(e.message), String(burstLevels));
  }
});

test('showFromArrivals: bad clients or events argument throws', () => {
  for (const clients of ['x', 0, 31, 1.5, NaN, undefined, null]) {
    assert.throws(() => showFromArrivals([lv(0, 1, 0)], clients), (e) => e.constructor === Error && /clients/.test(e.message), String(clients));
  }
  for (const ev of [undefined, null, {}, 'x']) {
    assert.throws(() => showFromArrivals(ev, 1), (e) => e.constructor === Error && /events/.test(e.message));
  }
});

test('checker: cost does not scale as clients * events', () => {
  const s = mk(2, 30);
  const reads = (N) => {
    const c = { id: 0, tMs: 0, level: 0 };
    const arrivals = [];
    for (let i = 0; i < N; i++) {
      // Counts reads of every field the checker touches per entry; a pass per client over all events would read them clients * N times.
      const e = {};
      for (const [k, v] of Object.entries({ id: i % 30, tMs: i, level: 0 })) {
        Object.defineProperty(e, k, { enumerable: true, get() { c[k]++; return v; } });
      }
      arrivals.push(e);
    }
    // level 0 only, every entry at its own instant: per client level 1 is missing and the instants are split
    const expected = Array.from({ length: 30 }, (_, id) => [`client ${id}: burst level 1 missing`, `client ${id}: burst levels not at one instant`]).flat();
    assert.deepEqual(showOnly(checkBurstInvariants(arrivals, [], s), expected),
      Array.from({ length: 30 }, (_, id) => `client ${id}: levels arrived but never shown`));
    return c.id + c.tMs + c.level;
  };
  const N = 6000;
  const r1 = reads(N);
  const r2 = reads(2 * N);
  assert.ok(r1 <= 8 * N, `reads ${r1} for ${N} entries (linear cost is about 6 per entry)`);
  assert.ok(r2 <= 8 * 2 * N && r2 <= 2 * r1 + 100, `reads grew from ${r1} to ${r2} when entries doubled`);
});

test('checker: missing burst levels and split instants are reported per client (repro)', () => {
  // client 0: levels 1 and 2 missing, levels 0 and 3 at different times
  const arrivals = [at(0, 100, 0), at(0, 200, 3)];
  const shown = [at(0, 100, 0), at(0, 200, 3)];
  assert.deepEqual(checkBurstInvariants(arrivals, shown, mk(4, 1)), [
    'client 0: burst level 1 missing',
    'client 0: burst level 2 missing',
    'client 0: burst levels not at one instant',
  ]);
});

test('checker: missing burst level alone (all at one instant)', () => {
  const arrivals = [at(0, 100, 0), at(0, 100, 1), at(0, 100, 3), at(1, 100, 0), at(1, 100, 1), at(1, 100, 2), at(1, 100, 3)];
  const shown = [at(0, 100, 3), at(1, 100, 3)];
  assert.deepEqual(checkBurstInvariants(arrivals, shown, mk(4, 2)), ['client 0: burst level 2 missing']);
});

test('checker: split instant alone, only the offending client is reported', () => {
  const arrivals = [at(0, 100, 0), at(0, 100, 1), at(0, 100, 2), at(0, 100, 3), at(1, 100, 0), at(1, 100, 1), at(1, 150, 2), at(1, 150, 3)];
  const shown = [at(0, 100, 3), at(1, 100, 1), at(1, 150, 3)];
  assert.deepEqual(checkBurstInvariants(arrivals, shown, mk(4, 2)), ['client 1: burst levels not at one instant']);
});

test('checker: simulated burst scenarios of every burstLevels have no violations, cost bounded', () => {
  for (let b = 1; b <= 4; b++) {
    for (const seed of [1, 2, 3]) {
      const sc = mk(b);
      const arrivals = burstArrivals(simulateClients(sc, { seed }), b);
      assert.deepEqual(checkBurstInvariants(arrivals, showFromArrivals(arrivals, 30), sc), []);
    }
  }
  // many bad clients: at most burstLevels + 1 completeness messages per client
  const v = checkBurstInvariants([at(0, 1, 0), at(0, 2, 1)], [], mk(4, 30));
  assert.ok(v.length <= 30 * 6);
});

test('checker: exact missing-level strings at the first and the last burst level (F-554)', () => {
  const lvls = (list) => list.map((l) => at(0, 100, l));
  const first = checkBurstInvariants(lvls([1, 2, 3]), [at(0, 100, 3)], mk(4, 1));
  assert.deepEqual(first, ['client 0: burst level 0 missing']);
  const last = checkBurstInvariants(lvls([0, 1, 2]), [at(0, 100, 2)], mk(4, 1));
  assert.deepEqual(last, ['client 0: burst level 3 missing']);
});

test('checker: same-instant duplicate arrival of one level is a violation (F-553)', () => {
  const v = checkBurstInvariants([at(0, 100, 0), at(0, 100, 0), at(0, 100, 1)], [at(0, 100, 1)], mk(2, 1));
  assert.deepEqual(v, ['client 0: level 0 arrived more than once at 100ms']);
  // a repeat at a different instant is reported as a split instant, not as a same-instant duplicate
  const w = checkBurstInvariants([at(0, 100, 0), at(0, 100, 1), at(0, 200, 1)], [at(0, 100, 1)], mk(2, 1));
  assert.ok(!w.some((m) => /more than once/.test(m)));
  assert.ok(w.includes('client 0: burst levels not at one instant'));
});

test('checker: 40000 shown events of one client finish quickly and match the small-case results (F-553 13)', () => {
  const N = 40000;
  const sc = { ...mk(2, 30), clients: 30 };
  // 40000 shown events of level 0 at distinct instants, but arrivals only contain level 1: tests repeated first-arrival lookups
  const arrivals = [];
  const shown = [];
  for (let i = 0; i < N; i++) arrivals.push(at(0, 1000 + i, 1));
  for (let i = 0; i < N; i++) shown.push(at(0, i, 0));
  const t0 = performance.now();
  const v = checkBurstInvariants(arrivals, shown, sc);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `took ${ms}ms`);
  assert.equal(v.filter((m) => /before it arrived|never arrived/.test(m)).length, N);
  assert.ok(v.includes('client 0: level 0 at 0ms never arrived'));
  const w = checkBurstInvariants([at(0, 200, 1)], [at(0, 100, 1)], mk(2, 1));
  assert.ok(w.includes('client 0: level 1 shown at 100ms before it arrived at 200ms'));
});

test('checker: a level arriving twice reports the FIRST arrival time', () => {
  const w = checkBurstInvariants([at(0, 200, 1), at(0, 300, 1)], [at(0, 100, 1)], mk(2, 1));
  assert.ok(w.includes('client 0: level 1 shown at 100ms before it arrived at 200ms'), w.join('|'));
  assert.ok(!w.some((m) => /arrived at 300ms/.test(m)));
});

test('burst firstArrival stores the FIRST arrival of a level when same level arrives twice (F-559)', () => {
  // When the same level arrives at multiple times, violation messages must reference the first arrival
  const v = checkBurstInvariants(
    [at(0, 100, 0), at(0, 200, 0), at(0, 100, 1)],
    [at(0, 50, 0)],
    mk(2, 1)
  );
  // Level 0 is shown at 50ms but arrives at 100ms (first) and 200ms (second)
  assert.ok(v.includes('client 0: level 0 shown at 50ms before it arrived at 100ms'), v.join('|'));
  // Must not reference the second arrival time
  assert.ok(!v.some((m) => /arrived at 200ms/.test(m)));
});
