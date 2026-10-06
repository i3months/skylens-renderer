import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateBurst, checkBurstInvariants, showFromArrivals, burstArrivals } from './index.mjs';
import { validateScenario } from '../../../contracts/load/index.mjs';

const mk = (burstLevels, clients = 30) => ({
  name: 'burst', kind: 'burst', clients, durationS: 10, burstLevels,
  path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: 10, e: 30, n: 0, u: 100 }],
});
const lv = (id, tMs, level) => ({ id, tMs, kind: 'level', level });
const at = (id, tMs, level) => ({ id, tMs, level });

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
  const v = checkBurstInvariants([at(0, 100, 0), at(0, 101, 3)], [], mk(4, 1));
  assert.deepEqual(v, ['client 0: levels arrived but never shown']);
});

test('checker: missed replacement is a violation', () => {
  const v = checkBurstInvariants([at(0, 100, 0), at(0, 101, 3)], [at(0, 100, 0)], mk(4, 1));
  assert.deepEqual(v, ['client 0: level 3 arrived at 101ms but was not shown']);
});

test('checker: decrease in unsorted shown input is caught after sorting', () => {
  const v = checkBurstInvariants([at(0, 200, 1), at(0, 100, 3)], [at(0, 200, 1), at(0, 100, 3)], mk(4, 1));
  assert.ok(v.includes('client 0: level 1 at 200ms shown after level 3'));
  assert.ok(v.includes('client 0: level 1 at 200ms shown while level 3 had arrived'));
});

test('checker: unsorted but valid input has no violations', () => {
  assert.deepEqual(checkBurstInvariants([at(0, 200, 1), at(0, 100, 3)], [at(0, 100, 3)], mk(4, 1)), []);
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
  for (const level of [4, -1, 1.5, NaN]) {
    const v = checkBurstInvariants([at(0, 100, 1)], [at(0, 100, 1), at(0, 150, level)], s);
    assert.equal(v.length, 1, `level ${level}`);
    assert.match(v[0], /^shown: client 0 level .* out of range 0\.\.3$/);
  }
  for (const id of [2, -1, 0.5]) {
    assert.deepEqual(checkBurstInvariants([], [at(id, 100, 1)], s), [`shown: id ${id} out of range 0..1`]);
  }
  assert.deepEqual(checkBurstInvariants([], [at(0, Infinity, 1)], s), ['shown: client 0 tMs Infinity not finite']);
  assert.deepEqual(checkBurstInvariants([at(0, 100, 7)], [], s), ['arrival: client 0 level 7 at 100ms out of range 0..3']);
});

test('checker: valid inputs have no violations', () => {
  const s = mk(4, 2);
  const arrivals = [at(0, 100, 0), at(0, 100, 1), at(1, 100, 2), at(0, 200, 3), at(0, 300, 2), at(1, 400, 3)];
  const shown = [at(0, 100, 1), at(1, 100, 2), at(0, 200, 3), at(1, 400, 3)];
  assert.deepEqual(checkBurstInvariants(arrivals, shown, s), []);
  assert.deepEqual(checkBurstInvariants([], [], s), []);
  assert.deepEqual(showFromArrivals(arrivals.map((a) => ({ ...a, kind: 'level' })), 2), shown);
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
        assert.ok(mine.length >= 1 && mine.length <= b);
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
  assert.deepEqual(checkBurstInvariants(arrivals, shown, mk(4, 1)), []);
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
  const N = 6000;
  let reads = 0;
  const arrivals = [];
  for (let i = 0; i < N; i++) {
    // Counts reads of the field the checker touches per entry; a pass per client over all events would read it clients * N times.
    const e = { id: i % 30, tMs: i };
    Object.defineProperty(e, 'level', { enumerable: true, get() { reads++; return 0; } });
    arrivals.push(e);
  }
  assert.deepEqual(checkBurstInvariants(arrivals, [], s), Array.from({ length: 30 }, (_, id) => `client ${id}: levels arrived but never shown`));
  assert.ok(reads <= 10 * N, `level reads ${reads} for ${N} entries`);
});
