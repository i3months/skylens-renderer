import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatsSampler, checkServerSamples } from './index.mjs';
import { runScenario } from '../run_all/run.mjs';

const L = { source: 'simulated', clock: 'simulated', cpuSource: 'simulated' };
function fake() {
  const st = { t: 0, user: 0, system: 0, rss: 104857600 };
  return {
    st,
    s: createStatsSampler({ cpuUsage: () => ({ user: st.user, system: st.system }), memoryUsage: () => ({ rss: st.rss }), now: () => st.t, clock: 'simulated' }),
  };
}

test('T16.2: first tick computes cpuPct against creation baseline (900000 us / 1000 ms = 90)', () => {
  const { st, s } = fake();
  st.t = 1000; st.user = 900000; s.tick();
  assert.deepEqual(s.samples(), [{ tS: 1, cpuPct: 90, rssMiB: 100, ...L }]);
});

test('T16.2: user+system over wall time; two cores fully busy read 200', () => {
  const { st, s } = fake();
  st.t = 1000; st.user = 300000; st.system = 200000; s.tick();
  st.t = 2000; st.user = 1300000; st.system = 1200000; s.tick(); // 2 s CPU in 1 s wall = 2 cores
  assert.deepEqual(s.samples(), [
    { tS: 1, cpuPct: 50, rssMiB: 100, ...L },
    { tS: 2, cpuPct: 200, rssMiB: 100, ...L },
  ]);
});

test('T16.2: 60 ticks give 60 samples with tS 1..60 and cpuPct 10', () => {
  const { st, s } = fake();
  for (let i = 1; i <= 60; i++) { st.t = i * 1000; st.user = i * 100000; s.tick(); }
  const xs = s.samples();
  assert.equal(xs.length, 60);
  assert.deepEqual(xs.map((x) => x.tS), Array.from({ length: 60 }, (_, i) => i + 1));
  assert.ok(xs.every((x) => x.cpuPct === 10));
});

test('T16.2: tS uses real elapsed time, irregular spacing; no intervalMs field', () => {
  const { st, s } = fake();
  st.t = 250; st.user = 25000; s.tick();
  st.t = 3250; st.user = 325000; s.tick();
  assert.deepEqual(s.samples(), [
    { tS: 0.25, cpuPct: 10, rssMiB: 100, ...L },
    { tS: 3.25, cpuPct: 10, rssMiB: 100, ...L },
  ]);
  assert.equal('intervalMs' in createStatsSampler({ clock: 'real' }), false);
});

test('T16.2: rss converted to MiB and rounded to 2 decimals', () => {
  const { st, s } = fake();
  st.t = 1000; st.rss = 123456789; s.tick(); // 117.7375... MiB
  st.t = 2000; st.rss = 1048576 * 5 + 5243; s.tick(); // 5.005 -> 5.01 (exact 5.005000...)
  assert.deepEqual(s.samples().map((x) => x.rssMiB), [117.74, 5.01]);
  assert.equal('rssMB' in s.samples()[0], false);
});

test('T16.2: zero elapsed skips the tick without throwing; next tick spans the gap', () => {
  const { st, s } = fake();
  st.user = 5; s.tick();
  assert.equal(s.samples().length, 0);
  st.t = 1000; st.user = 100000; s.tick();
  assert.deepEqual(s.samples(), [{ tS: 1, cpuPct: 10, rssMiB: 100, ...L }]);
});

test('T16.2: samples() returns copies', () => {
  const { st, s } = fake();
  st.t = 1000; s.tick();
  s.samples()[0].cpuPct = 99;
  assert.equal(s.samples()[0].cpuPct, 0);
});

test('F-530: samples carry source/clock; labels injectable for a real run', () => {
  const { st, s } = fake();
  st.t = 1000; s.tick();
  assert.deepEqual([s.samples()[0].source, s.samples()[0].clock], ['simulated', 'simulated']);
  const r = createStatsSampler({ cpuUsage: () => ({ user: 0, system: 0 }), now: () => st.t, source: 'server-process', clock: 'real' });
  st.t = 2000; r.tick();
  assert.deepEqual([r.samples()[0].source, r.samples()[0].clock], ['server-process', 'real']);
});

test('F-530: simulated now without injected cpuUsage (and vice versa) throws; neither is fine', () => {
  assert.throws(() => createStatsSampler({ clock: 'real', now: () => 0 }), /both now and cpuUsage/);
  assert.throws(() => createStatsSampler({ clock: 'real', cpuUsage: () => ({ user: 0, system: 0 }) }), /both now and cpuUsage/);
  assert.equal(createStatsSampler({ clock: 'real' }).samples().length, 0);
});

test('F-530: NaN cpu gives violations from checkServerSamples and runScenario', () => {
  const { st, s } = fake();
  const bad = createStatsSampler({ cpuUsage: () => ({ user: NaN, system: 0 }), now: () => st.t, clock: 'simulated' });
  st.t = 1000; bad.tick();
  assert.deepEqual(checkServerSamples(bad.samples()), ['server sample 0: cpuPct is not finite (NaN)']);
  assert.deepEqual(checkServerSamples(s.samples()), []);
  assert.deepEqual(checkServerSamples([{ tS: 1, cpuPct: 1, rssMiB: 1 }]), [
    'server sample 0: missing source', 'server sample 0: missing clock', 'server sample 0: bad cpuSource',
  ]);
  const steady = { name: 'steady30', kind: 'steady', clients: 30, durationS: 60, path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: 30, e: 150, n: 0, u: 100 }] };
  const { violations } = runScenario(steady, { commit: 'abcdef1', statsClock: { clock: 'simulated', cpuUsage: () => ({ user: NaN, system: 0 }), now: (() => { let t = 0; return () => (t += 1000); })() } });
  assert.ok(violations.some((v) => v.startsWith('steady30: server sample') && /not finite/.test(v)));
  assert.deepEqual(runScenario(steady, { commit: 'abcdef1' }).violations, []);
});

test('F-537: clock 는 명시 인자 - 누락/잘못된 값은 거부, now 주입 여부로 추론하지 않는다', () => {
  const inj = { cpuUsage: () => ({ user: 0, system: 0 }), now: () => 0 };
  assert.throws(() => createStatsSampler(), /clock must be/);
  assert.throws(() => createStatsSampler(inj), /clock must be/);
  assert.throws(() => createStatsSampler({ ...inj, clock: 'fake' }), /clock must be/);
  assert.throws(() => createStatsSampler({ clock: 'simulated' }), /simulated clock needs both/);
});

test('F-537: 모의 시계 표본은 source harness-process 로 라벨되지 않는다 / 실제 시계 기본은 harness-process', () => {
  const inj = { cpuUsage: () => ({ user: 0, system: 0 }) };
  let t = 0;
  const sim = createStatsSampler({ ...inj, now: () => t, clock: 'simulated' });
  t = 1000; sim.tick();
  assert.equal(sim.samples()[0].source, 'simulated');
  let rt = 0;
  const real = createStatsSampler({ ...inj, now: () => rt, clock: 'real' });
  rt = 1000; real.tick();
  assert.equal(real.samples()[0].source, 'harness-process');
  assert.equal(real.samples()[0].cpuSource, 'measured');
  const steady = { name: 'steady30', kind: 'steady', clients: 30, durationS: 3, path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: 3, e: 15, n: 0, u: 100 }] };
  const { serverSamples } = runScenario(steady, { commit: 'abcdef1' });
  assert.deepEqual(serverSamples.map((x) => [x.source, x.clock]), [['simulated', 'simulated'], ['simulated', 'simulated'], ['simulated', 'simulated']]);
});

const OK = { cpuPct: 1, rssMiB: 10, source: 's', clock: 'simulated', cpuSource: 'simulated' };
const mk = (nowSeq, extra = {}) => {
  let i = 0;
  return createStatsSampler({ cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ rss: 104857600 }), now: () => nowSeq[Math.min(i++, nowSeq.length - 1)], clock: 'simulated', ...extra });
};

test('F-538: non-finite elapsed time skips the tick (Infinity)', () => {
  const s = mk([0, Infinity]);
  s.tick();
  assert.deepEqual(s.samples(), []);
});

test('F-538: NaN now is skipped, finite ticks are recorded, no non-finite tS', () => {
  const s = mk([0, 1000, NaN, 2000]);
  s.tick(); s.tick(); s.tick();
  assert.deepEqual(s.samples().map((x) => x.tS), [1, 2]);
});

test('F-538: cpuStub gives cpuPct null and cpuSource stub, even with real cpuUsage injected', () => {
  const s = mk([0, 1000], { cpuStub: true });
  s.tick();
  assert.deepEqual(s.samples(), [{ tS: 1, cpuPct: null, rssMiB: 100, source: 'simulated', clock: 'simulated', cpuSource: 'stub' }]);
  assert.deepEqual(checkServerSamples(s.samples()), []);
});

test('F-538: checkServerSamples negative cpuPct', () => {
  assert.deepEqual(checkServerSamples([{ ...OK, cpuPct: -5, tS: 1 }]), ['server sample 0: cpuPct is negative (-5)']);
  assert.deepEqual(checkServerSamples([{ ...OK, rssMiB: -2, tS: 1 }]), ['server sample 0: rssMiB is negative (-2)']);
});

test('F-538: checkServerSamples does not throw on bad input', () => {
  assert.deepEqual(checkServerSamples([null]), ['server sample 0: not an object']);
  assert.deepEqual(checkServerSamples([undefined]), ['server sample 0: not an object']);
  assert.deepEqual(checkServerSamples(null), ['server samples: not an array']);
  assert.deepEqual(checkServerSamples(undefined), ['server samples: not an array']);
  assert.deepEqual(checkServerSamples([5]), ['server sample 0: not an object']);
});

test('F-538: tS must be finite, non-negative, strictly increasing', () => {
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 2 }, { ...OK, tS: 1 }]), ['server sample 1: tS not increasing']);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1 }, { ...OK, tS: 1 }]), ['server sample 1: tS not increasing']);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: Infinity }]), ['server sample 0: tS is not finite (Infinity)']);
  assert.deepEqual(checkServerSamples([{ ...OK }]), ['server sample 0: tS is not finite (undefined)']);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: -1 }]), ['server sample 0: tS is negative (-1)']);
});

test('F-538: stub vs measured cpuPct null handling', () => {
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1, cpuPct: null, cpuSource: 'stub' }]), []);
  assert.deepEqual(checkServerSamples([{ ...OK, clock: 'real', tS: 1, cpuPct: null, cpuSource: 'measured' }]), ['server sample 0: cpuPct is not finite (null)']);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1, cpuPct: 3, cpuSource: 'stub' }]), ['server sample 0: cpuPct must be null for stub (3)']);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1, cpuSource: 'x' }]), ['server sample 0: bad cpuSource']);
});

const REAL = { cpuPct: 1, rssMiB: 10, source: 'server-process', clock: 'real', cpuSource: 'measured' };

test('F-543: cpuSource is stub / simulated / measured by cpuStub and clock', () => {
  const inj = { cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ rss: 1048576 }) };
  const one = (extra) => { let t = 0; const s = createStatsSampler({ ...inj, now: () => t, ...extra }); t = 1000; s.tick(); return s.samples()[0].cpuSource; };
  assert.equal(one({ clock: 'simulated' }), 'simulated');
  assert.equal(one({ clock: 'real' }), 'measured');
  assert.equal(one({ clock: 'real', cpuStub: true }), 'stub');
  assert.equal(one({ clock: 'simulated', cpuStub: true }), 'stub');
});

test('F-543: checkServerSamples cpuSource/clock consistency', () => {
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1, cpuSource: 'measured' }]), ['server sample 0: measured cpu with simulated clock']);
  assert.deepEqual(checkServerSamples([{ ...REAL, tS: 1, cpuSource: 'simulated' }]), ['server sample 0: simulated cpu with real clock']);
  assert.deepEqual(checkServerSamples([{ ...REAL, tS: 1 }]), []);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1 }]), []);
  assert.deepEqual(checkServerSamples([{ ...REAL, tS: 1, cpuPct: null, cpuSource: 'stub' }]), []);
});

const R = (...ts) => ts.map((tS) => ({ ...REAL, tS }));
const seq = (n) => R(...Array.from({ length: n }, (_, i) => i + 1));

test('F-543/F-551: performance.now sampling in ~1 ms is a violation', () => {
  const s = createStatsSampler({ clock: 'real' });
  for (let i = 0; i < 60; i++) { const e = performance.now() + 0.01; while (performance.now() < e); s.tick(); }
  const v = checkServerSamples(s.samples(), { durationS: 60 });
  assert.ok(v.length >= 1);
  assert.ok(v.some((x) => /first tS .* is not within 0\.5 s of 1/.test(x)));
  assert.ok(v.some((x) => /interval .* s outside 0\.5\.\.1\.5/.test(x)));
});

test('F-551: acceptance cases', () => {
  assert.deepEqual(checkServerSamples(seq(60), { durationS: 60 }), []);
  assert.deepEqual(checkServerSamples(seq(60), {}), []);
  assert.ok(checkServerSamples(R(0.001, 60), { durationS: 60 }).length >= 1);
  assert.ok(checkServerSamples(R(0.0059, 0.006), { durationS: 1.005 }).length >= 1);
  assert.ok(checkServerSamples(R(0.00011), { durationS: 0.5 }).length >= 1);
  const over = checkServerSamples(R(...Array.from({ length: 60 }, (_, i) => i + 1), 60.5), { durationS: 60 });
  assert.ok(over.includes('server samples: 61 samples, expected 60'));
  assert.ok(over.includes('server samples: last tS 60.5 is not within 0.25 s of durationS 60'));
  // correct runs of partial durations
  assert.deepEqual(checkServerSamples(R(0.5), { durationS: 0.5 }), []);
  assert.deepEqual(checkServerSamples(R(1, 1.5), { durationS: 1.5 }), []);
  assert.deepEqual(checkServerSamples(R(1, 1.005), { durationS: 1.005 }), []);
  assert.deepEqual(checkServerSamples(R(1, 2, 2.5), { durationS: 2.5 }), []);
});

test('F-551: count, end, bad durationS, mixed clock/source', () => {
  assert.deepEqual(checkServerSamples(seq(59), { durationS: 60 }), [
    'server samples: 59 samples, expected 60',
    'server samples: last tS 59 is not within 0.25 s of durationS 60',
  ]);
  assert.deepEqual(checkServerSamples(seq(60), { durationS: 58.9 }), [
    'server samples: 60 samples, expected 59',
    'server samples: last tS 60 is not within 0.25 s of durationS 58.9',
  ]);
  assert.deepEqual(checkServerSamples(R(1, 2, 3, 3.2), { durationS: 3.5 }), ['server samples: last tS 3.2 is not within 0.25 s of durationS 3.5']);
  for (const bad of ['x', NaN, Infinity, 0, -1, null, undefined]) {
    const v = checkServerSamples(seq(3), { durationS: bad });
    assert.deepEqual(v, [`server samples: durationS must be a finite positive number (${String(bad)})`]);
  }
  const mixedClock = [{ ...REAL, tS: 1 }, { ...OK, tS: 2 }];
  assert.ok(checkServerSamples(mixedClock, { durationS: 2 }).includes('server samples: mixed clock'));
  const mixedSrc = [{ ...REAL, tS: 1 }, { ...REAL, source: 'other', tS: 2 }];
  assert.deepEqual(checkServerSamples(mixedSrc, { durationS: 2 }), ['server samples: mixed source']);
  // simulated clock: no timing checks, but the count is still checked (F-558)
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 0.001 }], { durationS: 1 }), []);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 0.001 }], { durationS: 60 }), ['server samples: 1 samples, expected 60']);
});

test('F-551/F-553: interval boundaries 0.5 and 1.5 pass, 0.49 and 1.51 fail', () => {
  const intervals = (ts, D) => checkServerSamples(R(...ts), { durationS: D }).filter((x) => /interval/.test(x));
  for (const d of [0.5, 1, 1.5]) assert.deepEqual(intervals([1, 1 + d, 2 + d, 3 + d], 3 + d), [], `d=${d}`);
  assert.deepEqual(checkServerSamples(R(1.5, 2.5, 3.5), { durationS: 3 }).filter((x) => /interval/.test(x)), []);
  for (const d of [0.49, 1.51]) {
    assert.deepEqual(intervals([1, 1 + d, 2 + d, 3 + d], 3 + d).slice(0, 1), [`server sample 1: interval ${1 + d - 1} s outside 0.5..1.5`], `d=${d}`);
  }
  // first interval is checked too (tS 1 -> 2.51)
  assert.equal(checkServerSamples(R(1, 2.51, 3.51), { durationS: 3.51 }).filter((x) => /^server sample 1:/.test(x)).length, 1);
  // first tS bounds: 0.5 and 1.5 pass, 0.49 and 1.51 fail
  assert.deepEqual(checkServerSamples(R(0.5, 1.5, 2.5), { durationS: 2.5 }), []);
  assert.ok(checkServerSamples(R(0.49, 1.5, 2.5), { durationS: 2.5 }).some((x) => /^server sample 0: first tS/.test(x)));
  assert.ok(checkServerSamples(R(1.51, 2.5, 3.5), { durationS: 3.5 }).some((x) => /^server sample 0: first tS/.test(x)));
  // last (partial bucket) interval: width 0.5 +- 0.5 for durationS 2.5
  assert.deepEqual(checkServerSamples(R(1, 2, 2.5), { durationS: 2.5 }), []);
  assert.deepEqual(checkServerSamples(R(1, 2, 2.2), { durationS: 2.5 }).length, 1);
});

test('F-553: checkServerSamples with null/non-object options does not throw', () => {
  for (const o of [null, 5, 'x']) {
    let v;
    assert.doesNotThrow(() => { v = checkServerSamples(seq(2), o); });
    assert.ok(Array.isArray(v));
    assert.deepEqual(v, []);
  }
  assert.doesNotThrow(() => checkServerSamples(null, null));
  assert.deepEqual(checkServerSamples(null, null), ['server samples: not an array']);
  assert.deepEqual(checkServerSamples(undefined), ['server samples: not an array']);
});

test('F-548: null/undefined memoryUsage or cpuUsage skips the tick, keeps baseline', () => {
  for (const bad of [null, undefined]) {
    let t = 0; let mem = { rss: 104857600 }; let cpu = { user: 0, system: 0 };
    const s = createStatsSampler({ cpuUsage: () => cpu, memoryUsage: () => mem, now: () => t, clock: 'simulated' });
    t = 1000; mem = bad; assert.doesNotThrow(() => s.tick());
    assert.equal(s.samples().length, 0);
    t = 2000; mem = { rss: 104857600 }; cpu = bad; assert.doesNotThrow(() => s.tick());
    assert.equal(s.samples().length, 0);
    t = 3000; cpu = { user: 300000, system: 0 }; s.tick();
    assert.deepEqual(s.samples(), [{ tS: 3, cpuPct: 10, rssMiB: 100, ...L }]);
  }
});

test('F-548: sparse arrays are reported, not skipped', () => {
  // eslint-disable-next-line no-sparse-arrays
  assert.deepEqual(checkServerSamples([,]), ['server sample 0: not an object']);
  // eslint-disable-next-line no-sparse-arrays
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1 }, , { ...OK, tS: 2 }]), ['server sample 1: not an object']);
});

test('F-548: rssMiB non-finite and empty source violations', () => {
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1, rssMiB: NaN }]), ['server sample 0: rssMiB is not finite (NaN)']);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1, rssMiB: Infinity }]), ['server sample 0: rssMiB is not finite (Infinity)']);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1, rssMiB: undefined }]), ['server sample 0: rssMiB is not finite (undefined)']);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1, source: '' }]), ['server sample 0: missing source']);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 1, clock: '' }]), ['server sample 0: missing clock']);
});

const last = (t) => [...seq(59), ...R(t)];

test('F-555: a real timer that wakes a few ms late on the last tick is not a violation', () => {
  assert.deepEqual(checkServerSamples(last(60.004), { durationS: 60 }), []);
  assert.deepEqual(checkServerSamples(last(60.05), { durationS: 60 }), []);
  // the four F-551 inputs still violate
  assert.ok(checkServerSamples(R(0.001, 60), { durationS: 60 }).length >= 1);
  assert.ok(checkServerSamples(R(0.0059, 0.006), { durationS: 1.005 }).length >= 1);
  assert.ok(checkServerSamples(R(0.00011), { durationS: 0.5 }).length >= 1);
  assert.deepEqual(checkServerSamples([...seq(60), ...R(60.5)], { durationS: 60 }), [
    'server samples: 61 samples, expected 60',
    'server samples: last tS 60.5 is not within 0.25 s of durationS 60',
  ]);
  // an extra sample inside the late window is caught by the count check
  assert.deepEqual(checkServerSamples([...seq(60), ...R(60.2)], { durationS: 60 }), [
    'server samples: 61 samples, expected 60',
    'server sample 60: interval 0.20000000000000284 s outside 0.5..1.5',
  ]);
});

test('F-555/F-559: last tS boundary is durationS +- 0.25 on both sides', () => {
  assert.deepEqual(checkServerSamples(last(60.25), { durationS: 60 }), []);
  assert.deepEqual(checkServerSamples(last(60.26), { durationS: 60 }), ['server samples: last tS 60.26 is not within 0.25 s of durationS 60']);
  assert.deepEqual(checkServerSamples(last(59.75), { durationS: 60 }), []);
  assert.deepEqual(checkServerSamples(last(59.74), { durationS: 60 }), ['server samples: last tS 59.74 is not within 0.25 s of durationS 60']);
});

test('F-558: with durationS the count is checked for any clock, also for an empty array', () => {
  assert.deepEqual(checkServerSamples([], { durationS: 60 }), ['server samples: 0 samples, expected 60']);
  assert.deepEqual(checkServerSamples([], {}), []);
  assert.deepEqual(checkServerSamples([]), []);
  const sim = Array.from({ length: 60 }, (_, i) => ({ ...OK, tS: i + 1 }));
  assert.deepEqual(checkServerSamples(sim, { durationS: 60 }), []);
  assert.deepEqual(checkServerSamples(sim.slice(0, 59), { durationS: 60 }), ['server samples: 59 samples, expected 60']);
  assert.deepEqual(checkServerSamples(seq(60), { durationS: 60 }), []);
});

test('F-559: last interval is checked against the final bucket width, not 0.5..1.5', () => {
  assert.deepEqual(checkServerSamples(R(0.9, 1.4, 2.5), { durationS: 2.5 }), ['server sample 2: interval 1.1 s outside 0..1']);
  assert.deepEqual(checkServerSamples(R(0.9, 1.39, 2.5), { durationS: 2.5 }), [
    'server sample 1: interval 0.4899999999999999 s outside 0.5..1.5',
    'server sample 2: interval 1.11 s outside 0..1',
  ]);
  assert.deepEqual(checkServerSamples(R(1, 2, 2.2), { durationS: 2.5 }), ['server samples: last tS 2.2 is not within 0.25 s of durationS 2.5']);
  assert.deepEqual(checkServerSamples(R(1, 2, 2.9), { durationS: 2.2 }), [
    'server samples: last tS 2.9 is not within 0.25 s of durationS 2.2',
    'server sample 2: interval 0.8999999999999999 s outside 0..0.7000000000000002',
  ]);
});

test('F-559: boundary pairs give exact violation arrays', () => {
  // first tS: 0.5 passes, 0.49 fails; 1.5 passes, 1.51 fails
  assert.deepEqual(checkServerSamples(R(0.5, 1.5, 2.5), { durationS: 2.5 }), []);
  assert.deepEqual(checkServerSamples(R(0.49, 1.5, 2.5), { durationS: 2.5 }), ['server sample 0: first tS 0.49 is not within 0.5 s of 1']);
  assert.deepEqual(checkServerSamples(R(1.5, 2.5, 3), { durationS: 3 }), []);
  assert.deepEqual(checkServerSamples(R(1.51, 2.5, 3), { durationS: 3 }), ['server sample 0: first tS 1.51 is not within 0.5 s of 1']);
  // interval: 0.5 and 1.5 pass, 0.49 and 1.51 fail
  assert.deepEqual(checkServerSamples(R(1, 1.5, 2.5, 3.5), { durationS: 3.5 }), []);
  assert.deepEqual(checkServerSamples(R(1, 2.5, 3.5, 4), { durationS: 3.75 }), []);
  assert.deepEqual(checkServerSamples(R(1, 1.49, 2.49, 3), { durationS: 3.25 }), ['server sample 1: interval 0.49 s outside 0.5..1.5']);
  assert.deepEqual(checkServerSamples(R(1, 2.51, 3.51, 4), { durationS: 3.75 }), ['server sample 1: interval 1.5099999999999998 s outside 0.5..1.5']);
});

test('F-559: a non-object sample skips the real-clock timing checks without throwing', () => {
  assert.deepEqual(checkServerSamples([null, ...R(1)], { durationS: 2 }), ['server sample 0: not an object']);
  assert.deepEqual(checkServerSamples([null, ...R(1)], { durationS: 1 }), ['server sample 0: not an object', 'server samples: 2 samples, expected 1']);
});

test('F-559: normal runs whose subtraction lands just outside a bound still pass (1e-9 slack)', () => {
  // 1.13 - 0.63 = 0.4999999999999999, 2.2 - 0.7 = 1.5000000000000002
  assert.deepEqual(checkServerSamples(R(0.63, 1.13, 2.5, 4), { durationS: 4 }), []);
  assert.deepEqual(checkServerSamples(R(0.7, 2.2, 3.2, 4), { durationS: 4 }), []);
  // 0.55 - 0.3 and 4.15 - 3.9 are a hair over 0.25
  assert.deepEqual(checkServerSamples(R(0.55), { durationS: 0.3 }), []);
  assert.deepEqual(checkServerSamples(R(1, 2, 3, 4.15), { durationS: 3.9 }), []);
});

test('F-560: a null creation-time cpuUsage is not a TypeError; the first usable reading becomes the baseline', () => {
  for (const bad of [null, undefined]) {
    let t = 0; let n = 0;
    const s = createStatsSampler({ cpuUsage: () => (n++ === 0 ? bad : { user: n * 100000, system: 0 }), memoryUsage: () => ({ rss: 104857600 }), now: () => t, clock: 'simulated' });
    t = 1000; assert.doesNotThrow(() => s.tick());
    assert.deepEqual(s.samples(), []);
    t = 2000; s.tick();
    assert.deepEqual(s.samples(), [{ tS: 2, cpuPct: 10, rssMiB: 100, ...L }]);
  }
});
