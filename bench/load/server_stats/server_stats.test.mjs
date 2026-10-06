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

test('F-543: durationS - performance.now sampling in ~1 ms is a violation', () => {
  const s = createStatsSampler({ clock: 'real' });
  for (let i = 0; i < 60; i++) { const e = performance.now() + 0.01; while (performance.now() < e); s.tick(); }
  const v = checkServerSamples(s.samples(), { durationS: 60 });
  assert.ok(v.length >= 1);
  assert.ok(v.some((x) => /not within 1 s of durationS 60/.test(x)));
  assert.ok(v.some((x) => /interval .* s outside 0\.5\.\.1\.5/.test(x)));
});

test('F-543: durationS - proper 1 s spacing passes; bad interval and bad end reported', () => {
  const good = Array.from({ length: 60 }, (_, i) => ({ ...REAL, tS: i + 1 }));
  assert.deepEqual(checkServerSamples(good, { durationS: 60 }), []);
  assert.deepEqual(checkServerSamples(good, {}), []);
  assert.deepEqual(checkServerSamples(good, { durationS: 'x' }), []);
  assert.deepEqual(checkServerSamples(good, { durationS: 58.9 }), ['server samples: last tS 60 is not within 1 s of durationS 58.9']);
  assert.deepEqual(checkServerSamples(good, { durationS: 59 }), []);
  const gap = [1, 2, 4, 5].map((tS) => ({ ...REAL, tS }));
  assert.deepEqual(checkServerSamples(gap, { durationS: 5 }), ['server sample 2: interval 2 s outside 0.5..1.5']);
  const fast = [1, 1.2, 2.5, 3.5].map((tS) => ({ ...REAL, tS }));
  assert.deepEqual(checkServerSamples(fast, { durationS: 3.5 }), ['server sample 1: interval 0.19999999999999996 s outside 0.5..1.5']);
  // final interval is exempt; simulated clock is not checked
  assert.deepEqual(checkServerSamples([{ ...REAL, tS: 1 }, { ...REAL, tS: 1.1 }], { durationS: 1 }), []);
  assert.deepEqual(checkServerSamples([{ ...OK, tS: 0.001 }], { durationS: 60 }), []);
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
