import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatsSampler } from './index.mjs';

function fake() {
  const st = { t: 0, user: 0, system: 0, rss: 104857600 };
  return {
    st,
    s: createStatsSampler({ cpuUsage: () => ({ user: st.user, system: st.system }), memoryUsage: () => ({ rss: st.rss }), now: () => st.t }),
  };
}

test('T16.2: first tick computes cpuPct against creation baseline (900000 us / 1000 ms = 90)', () => {
  const { st, s } = fake();
  st.t = 1000; st.user = 900000; s.tick();
  assert.deepEqual(s.samples(), [{ tS: 1, cpuPct: 90, rssMiB: 100 }]);
});

test('T16.2: user+system over wall time; two cores fully busy read 200', () => {
  const { st, s } = fake();
  st.t = 1000; st.user = 300000; st.system = 200000; s.tick();
  st.t = 2000; st.user = 1300000; st.system = 1200000; s.tick(); // 2 s CPU in 1 s wall = 2 cores
  assert.deepEqual(s.samples(), [
    { tS: 1, cpuPct: 50, rssMiB: 100 },
    { tS: 2, cpuPct: 200, rssMiB: 100 },
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
    { tS: 0.25, cpuPct: 10, rssMiB: 100 },
    { tS: 3.25, cpuPct: 10, rssMiB: 100 },
  ]);
  assert.equal('intervalMs' in createStatsSampler(), false);
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
  assert.deepEqual(s.samples(), [{ tS: 1, cpuPct: 10, rssMiB: 100 }]);
});

test('T16.2: samples() returns copies', () => {
  const { st, s } = fake();
  st.t = 1000; s.tick();
  s.samples()[0].cpuPct = 99;
  assert.equal(s.samples()[0].cpuPct, 0);
});
