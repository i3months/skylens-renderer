import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateClients, countOpenConnections, connectionViolations } from './index.mjs';
import { validateEvent, rng } from '../../../contracts/load/harness.mjs';

const steady = (clients, durationS = 10) => ({
  name: 'steady', kind: 'steady', clients, durationS,
  path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: durationS, e: 30, n: 0, u: 100 }],
});

test('30 clients all stay connected until durationS*1000', () => {
  const ev = simulateClients(steady(30), { seed: 1 });
  const closes = ev.filter((e) => e.kind === 'close');
  const connects = ev.filter((e) => e.kind === 'connect');
  assert.equal(connects.length, 30);
  assert.equal(closes.length, 30);
  assert.deepEqual([...new Set(ev.map((e) => e.id))].sort((a, b) => a - b), [...Array(30).keys()]);
  const lastConnect = Math.max(...connects.map((e) => e.tMs));
  const firstClose = Math.min(...closes.map((e) => e.tMs));
  assert.ok(lastConnect < firstClose);
  assert.ok(lastConnect <= 200);
  for (const c of closes) assert.equal(c.tMs, 10000);
});

test('each client gets levels 0..3 in order, one first_frame, bytes with latency', () => {
  const ev = simulateClients(steady(30), { seed: 7 });
  for (let id = 0; id < 30; id++) {
    const mine = ev.filter((e) => e.id === id);
    assert.deepEqual(mine.filter((e) => e.kind === 'level').map((e) => e.level), [0, 1, 2, 3]);
    assert.equal(mine.filter((e) => e.kind === 'first_frame').length, 1);
    assert.equal(mine.filter((e) => e.kind === 'bytes').length, 4);
    assert.equal(mine[0].kind, 'connect');
    assert.equal(mine[mine.length - 1].kind, 'close');
  }
});

test('sorted by tMs then id', () => {
  const ev = simulateClients(steady(30), { seed: 3 });
  for (let i = 1; i < ev.length; i++) {
    assert.ok(ev[i - 1].tMs < ev[i].tMs || (ev[i - 1].tMs === ev[i].tMs && ev[i - 1].id <= ev[i].id));
  }
});

test('same seed same log, different seed differs', () => {
  assert.deepEqual(simulateClients(steady(30), { seed: 5 }), simulateClients(steady(30), { seed: 5 }));
  assert.notDeepEqual(simulateClients(steady(30), { seed: 5 }), simulateClients(steady(30), { seed: 6 }));
});

test('every event passes validateEvent', () => {
  for (const clients of [1, 30]) {
    for (const e of simulateClients(steady(clients), { seed: 9 })) assert.deepEqual(validateEvent(e, clients), []);
  }
});

test('single-client scenarios work for every kind', () => {
  const base = steady(1);
  for (const s of [base, { ...base, kind: 'burst', burstLevels: 4 }, { ...base, kind: 'slow_link', linkBytesPerS: 50000 }]) {
    const ev = simulateClients(s, { seed: 2 });
    assert.equal(ev.filter((e) => e.kind === 'connect').length, 1);
    assert.equal(ev.filter((e) => e.kind === 'close').length, 1);
    assert.deepEqual(ev.filter((e) => e.kind === 'level').map((e) => e.level), [0, 1, 2, 3]);
    for (const e of ev) assert.deepEqual(validateEvent(e, 1), []);
  }
});

const burst30 = { ...steady(30, 60), name: 'burst30', kind: 'burst', burstLevels: 4 };

test('burst30 seed 1: levels 0..3 of each client share one tMs, first_frame at that tMs', () => {
  const ev = simulateClients(burst30, { seed: 1 });
  for (let id = 0; id < 30; id++) {
    const mine = ev.filter((e) => e.id === id);
    const lv = mine.filter((e) => e.kind === 'level');
    assert.deepEqual(lv.map((e) => e.level), [0, 1, 2, 3]);
    assert.equal(new Set(lv.map((e) => e.tMs)).size, 1);
    const by = mine.filter((e) => e.kind === 'bytes');
    assert.equal(by.length, 4);
    for (const b of by) assert.equal(b.tMs, lv[0].tMs);
    const ff = mine.filter((e) => e.kind === 'first_frame');
    assert.equal(ff.length, 1);
    assert.equal(ff[0].tMs, lv[0].tMs);
  }
});

test('burstLevels 2: levels 0,1 together, levels 2,3 later and spaced', () => {
  const ev = simulateClients({ ...burst30, burstLevels: 2 }, { seed: 1 });
  for (let id = 0; id < 30; id++) {
    const t = ev.filter((e) => e.id === id && e.kind === 'level').map((e) => e.tMs);
    assert.equal(t[0], t[1]);
    assert.ok(t[2] > t[1] && t[3] > t[2]);
  }
});

test('slow link adds latency', () => {
  const slow = simulateClients({ ...steady(1, 60), kind: 'slow_link', linkBytesPerS: 10000 }, { seed: 2 });
  assert.ok(Math.max(...slow.filter((e) => e.kind === 'bytes').map((e) => e.latencyMs)) > 5000);
});

test('durationS 1: nothing arrives after close, no clamped fake arrivals', () => {
  for (const kind of ['steady', 'burst']) {
    const dur = kind === 'burst' ? 0.3 : 1;
    const closeAt = dur * 1000;
    const sc = { ...steady(30, dur), kind, ...(kind === 'burst' ? { burstLevels: 4 } : {}) };
    const ev = simulateClients(sc, { seed: 1 });
    let dropped = 0;
    for (let id = 0; id < 30; id++) {
      const mine = ev.filter((e) => e.id === id);
      const lv = mine.filter((e) => e.kind === 'level');
      assert.deepEqual(lv.map((e) => e.level), [0, 1, 2, 3].slice(0, lv.length)); // a prefix, never gaps
      if (lv.length < 4) dropped++;
      for (const e of mine) if (e.kind !== 'close') assert.ok(e.tMs <= closeAt);
      // clamped fake arrivals would pile several distinct levels onto closeMs in steady mode
      if (kind === 'steady') assert.ok(mine.filter((e) => e.kind === 'level' && e.tMs === closeAt).length <= 1);
      assert.equal(mine.filter((e) => e.kind === 'first_frame').length, lv.length ? 1 : 0);
    }
    assert.ok(dropped > 0, `${kind}: some client must miss levels in ${dur} s`);
  }
});

test('invalid scenario or seed throws', () => {
  assert.throws(() => simulateClients({ ...steady(3), kind: 'nope' }, { seed: 1 }), /invalid scenario/);
  assert.throws(() => simulateClients({ ...steady(3), clients: 0 }, { seed: 1 }), /invalid scenario/);
  assert.throws(() => simulateClients({ ...steady(3), kind: 'burst' }, { seed: 1 }), /invalid scenario/);
  assert.throws(() => simulateClients(null, { seed: 1 }));
  for (const seed of [undefined, -1, 1.5, 2 ** 32, NaN, Infinity, '1']) {
    assert.throws(() => simulateClients(steady(3), { seed }), /seed/);
  }
  assert.doesNotThrow(() => simulateClients(steady(3), { seed: 0 }));
  assert.doesNotThrow(() => simulateClients(steady(3), { seed: 2 ** 32 - 1 }));
});

test('open connections: min equals clients through the run', () => {
  for (const sc of [steady(30), burst30, steady(30, 1)]) {
    const r = countOpenConnections(simulateClients(sc, { seed: 4 }));
    assert.deepEqual(r, { min: 30, max: 30 });
  }
  const ev = simulateClients(steady(5), { seed: 4 });
  // a client closing early drops min
  const dropped = ev.map((e) => (e.kind === 'close' && e.id === 2 ? { ...e, tMs: 5000 } : e)).sort((a, b) => a.tMs - b.tMs);
  assert.equal(countOpenConnections(dropped).min, 4);
  assert.deepEqual(countOpenConnections([]), { min: 0, max: 0 });
});

// Independent reference of the seeded draw schedule: per client, request time and payload size of each level.
function referenceDraws(scenario, seed) {
  const rand = rng(seed);
  const burst = scenario.kind === 'burst' ? scenario.burstLevels : 1;
  const sizes = [4000, 12000, 40000, 120000];
  const out = [];
  for (let id = 0; id < scenario.clients; id++) {
    const connect = Math.min(Math.round(rand() * 200), Math.floor((scenario.durationS * 1000) / 10));
    let t = connect + 300 * (0.5 + rand());
    const draws = [];
    for (let level = 0; level < 4; level++) {
      if (level >= burst) t += 400 * (0.5 + rand());
      const bytes = Math.round(sizes[level] * (0.8 + 0.4 * rand()));
      rand(); // latency draw
      draws.push({ t, bytes });
    }
    out.push(draws);
  }
  return out;
}

test('bytes latencyMs equals arrival minus request time (burst group sharing included)', () => {
  for (const sc of [steady(30, 60), burst30, { ...burst30, burstLevels: 2 }]) {
    for (const seed of [1, 2, 3, 11, 42]) {
      const ref = referenceDraws(sc, seed);
      const ev = simulateClients(sc, { seed });
      for (let id = 0; id < sc.clients; id++) {
        const by = ev.filter((e) => e.id === id && e.kind === 'bytes');
        assert.equal(by.length, 4);
        by.forEach((b, level) => {
          assert.ok(Math.abs(b.latencyMs - (b.tMs - ref[id][level].t)) <= 0.5, `${sc.kind} seed ${seed} client ${id} level ${level}`);
        });
      }
    }
  }
});

test('burstLevels 4 seed 1 client 0: all four bytes latencies are equal', () => {
  const by = simulateClients(burst30, { seed: 1 }).filter((e) => e.id === 0 && e.kind === 'bytes');
  assert.equal(by.length, 4);
  assert.equal(new Set(by.map((e) => e.latencyMs)).size, 1);
});

test('generated bytes total matches an independent computation', () => {
  for (const sc of [steady(30, 60), burst30]) {
    const ref = referenceDraws(sc, 5);
    const ev = simulateClients(sc, { seed: 5 });
    for (let id = 0; id < sc.clients; id++) {
      const total = ev.filter((e) => e.id === id && e.kind === 'bytes').reduce((a, e) => a + e.bytes, 0);
      assert.equal(total, ref[id].reduce((a, d) => a + d.bytes, 0));
    }
  }
});

// Hand-built log: every id in `ids` connects at 0 (and closes at 1000), extra events appended as given.
const manual = (ids, extra = []) => [
  ...ids.map((id) => ({ id, tMs: 0, kind: 'connect' })),
  ...extra,
  ...ids.map((id) => ({ id, tMs: 1000, kind: 'close' })),
];

test('duplicate connect cannot mask a missing connect (30 clients, 3 never connects, 4 twice)', () => {
  const ids = [...Array(30).keys()].filter((i) => i !== 3);
  const ev = manual(ids, [{ id: 4, tMs: 10, kind: 'connect' }]);
  assert.deepEqual(connectionViolations(ev, 30), ['client 3: never connected', 'client 4: duplicate connect']);
  assert.deepEqual(countOpenConnections(ev), { min: 29, max: 29 });
});

test('connectionViolations: healthy log is clean, close without connect, ordering by id', () => {
  assert.deepEqual(connectionViolations(simulateClients(steady(30), { seed: 4 }), 30), []);
  const ev = [
    { id: 2, tMs: 0, kind: 'connect' }, { id: 2, tMs: 1, kind: 'connect' },
    { id: 1, tMs: 2, kind: 'close' },
    { id: 0, tMs: 3, kind: 'connect' }, { id: 0, tMs: 4, kind: 'connect' },
  ];
  assert.deepEqual(connectionViolations(ev, 4), [
    'client 0: duplicate connect', 'client 1: close without connect',
    'client 1: never connected', 'client 2: duplicate connect', 'client 3: never connected',
  ]);
});

test('countOpenConnections ignores a close for an id that is not open', () => {
  const ev = [
    { id: 0, tMs: 0, kind: 'connect' }, { id: 1, tMs: 1, kind: 'close' },
    { id: 0, tMs: 100, kind: 'close' },
  ];
  assert.deepEqual(countOpenConnections(ev), { min: 1, max: 1 });
});

test('connectionViolations: bad clients returns immediately without looping', () => {
  const t0 = performance.now();
  const huge = connectionViolations([], 1e7);
  assert.ok(performance.now() - t0 < 1000);
  assert.deepEqual(huge, ['bad clients: 10000000 (must be an integer in 1..30)']);
  for (const bad of [NaN, 0, 1.5, -1, 31, Infinity, '3', undefined]) {
    const r = connectionViolations([], bad);
    assert.equal(r.length, 1);
    assert.ok(r[0].startsWith('bad clients: '), String(bad));
  }
  assert.equal(connectionViolations([], 30).length, 30);
});

test('connectionViolations: never throws on non-array logs or non-object events', () => {
  for (const bad of [null, undefined, 5, 'x', {}]) assert.deepEqual(connectionViolations(bad, 3), ['event log: not an array']);
  assert.deepEqual(connectionViolations([[]], 1), ['event 0: not an object', 'client 0: never connected']);
  assert.deepEqual(connectionViolations([null], 1), ['event 0: not an object', 'client 0: never connected']);
  assert.deepEqual(connectionViolations([{ id: 0, tMs: 0, kind: 'connect' }, 7, undefined], 1), ['event 1: not an object', 'event 2: not an object']);
  assert.deepEqual(connectionViolations([, { id: 0, tMs: 0, kind: 'connect' }], 1), ['event 0: not an object']);
});
