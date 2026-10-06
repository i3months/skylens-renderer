import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatsSampler } from './index.mjs';

function mk({ cpu = () => ({ user: 0, system: 0 }), mem = () => ({ rss: 104857600 }) } = {}) {
  const st = { t: 0 };
  const s = createStatsSampler({ cpuUsage: () => cpu(st), memoryUsage: () => mem(st), now: () => st.t, clock: 'simulated' });
  return { st, s };
}
const noNaN = (samples) => assert.ok(samples.every((x) => Object.values(x).every((v) => typeof v !== 'number' || Number.isFinite(v))));

for (const [name, badMem] of [['{}', {}], ["{rss:'x'}", { rss: 'x' }]]) {
  test(`F-563: memoryUsage ${name} skips the tick, no NaN, no throw`, () => {
    let bad = true;
    const { st, s } = mk({ mem: () => (bad ? badMem : { rss: 104857600 }) });
    st.t = 1000; assert.doesNotThrow(() => s.tick());
    assert.deepEqual(s.samples(), []);
    bad = false; st.t = 2000; s.tick();
    assert.equal(s.samples().length, 1);
    noNaN(s.samples());
  });
}

test("F-563: cpuUsage {user:'a',system:0} skips the tick, no NaN, no throw", () => {
  let bad = false;
  const { st, s } = mk({ cpu: () => (bad ? { user: 'a', system: 0 } : { user: 0, system: 0 }) });
  bad = true;
  st.t = 1000; assert.doesNotThrow(() => s.tick());
  assert.deepEqual(s.samples(), []);
  bad = false; st.t = 2000; s.tick();
  assert.equal(s.samples().length, 1);
  noNaN(s.samples());
});

test('F-563: non-numeric creation-time baseline: first good tick becomes baseline, no NaN', () => {
  let n = 0;
  const { st, s } = mk({ cpu: () => (n++ === 0 ? { user: 'a', system: 0 } : { user: 0, system: 0 }) });
  st.t = 1000; s.tick();
  st.t = 2000; s.tick();
  assert.equal(s.samples().length, 1);
  noNaN(s.samples());
});

test('F-563: first cpuUsage() null does not throw; tick becomes baseline', () => {
  let n = 0;
  const { st, s } = mk({ cpu: () => (n++ === 0 ? null : { user: 0, system: 0 }) });
  st.t = 1000; assert.doesNotThrow(() => s.tick());
  assert.deepEqual(s.samples(), []);
  st.t = 2000; s.tick();
  assert.equal(s.samples().length, 1);
});
