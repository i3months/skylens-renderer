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

test('T16.2: cpuPct 50 and rss 100 MB, first tick cpuPct 0', () => {
  const { st, s } = fake();
  st.t = 1000; st.user = 300000; st.system = 200000; s.tick();
  st.t = 2000; st.user = 800000; st.system = 200000; s.tick();
  assert.deepEqual(s.samples(), [
    { tS: 1, cpuPct: 0, rssMB: 100 },
    { tS: 2, cpuPct: 50, rssMB: 100 },
  ]);
});

test('T16.2: five 1 s ticks give five samples spaced 1 s', () => {
  const { st, s } = fake();
  for (let i = 1; i <= 5; i++) { st.t = i * 1000; st.user = i * 100000; s.tick(); }
  const xs = s.samples();
  assert.equal(xs.length, 5);
  assert.deepEqual(xs.map((x) => x.tS), [1, 2, 3, 4, 5]);
  assert.deepEqual(xs.slice(1).map((x) => x.cpuPct), [10, 10, 10, 10]);
});

test('T16.2: zero wall delta gives cpuPct 0 and samples() is a copy', () => {
  const { st, s } = fake();
  st.user = 5; s.tick(); s.tick();
  assert.equal(s.samples()[1].cpuPct, 0);
  s.samples()[0].cpuPct = 99;
  assert.equal(s.samples()[0].cpuPct, 0);
});
