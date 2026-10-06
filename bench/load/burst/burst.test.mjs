import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateBurst, checkBurstInvariants } from './index.mjs';
import { validateScenario } from '../../../contracts/load/index.mjs';

const mk = (burstLevels, clients = 30) => ({
  name: 'burst', kind: 'burst', clients, durationS: 10, burstLevels,
  path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: 10, e: 30, n: 0, u: 100 }],
});

test('scenario helper is valid', () => assert.deepEqual(validateScenario(mk(2)), []));

test('burst shows only the highest level, no violations', () => {
  for (let b = 1; b <= 4; b++) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = simulateBurst(mk(b), { seed });
      assert.deepEqual(r.violations, []);
      assert.equal(r.shown.length, 30);
      assert.deepEqual(r.shown.map((s) => s.level), Array(30).fill(b - 1));
      assert.deepEqual([...new Set(r.shown.map((s) => s.id))].length, 30);
    }
  }
});

test('deterministic per seed, differs across seeds', () => {
  assert.deepEqual(simulateBurst(mk(4), { seed: 7 }), simulateBurst(mk(4), { seed: 7 }));
  assert.notDeepEqual(simulateBurst(mk(4), { seed: 7 }).shown, simulateBurst(mk(4), { seed: 8 }).shown);
});

test('rejects non-burst scenario', () => {
  assert.throws(() => simulateBurst({ ...mk(2), kind: 'steady' }, { seed: 1 }));
});

test('level decrease is a violation', () => {
  const s = mk(4, 1);
  assert.deepEqual(
    checkBurstInvariants([{ id: 0, tMs: 100, level: 3 }, { id: 0, tMs: 200, level: 1 }], s),
    ['client 0: level 1 at 200ms shown after level 3'],
  );
});

test('level that never arrived is a violation', () => {
  const s = mk(2, 1);
  assert.deepEqual(
    checkBurstInvariants([{ id: 0, tMs: 100, level: 3 }], s),
    ['client 0: level 3 at 100ms never arrived'],
  );
});

test('two shows in one instant is a violation', () => {
  const s = mk(2, 1);
  assert.deepEqual(
    checkBurstInvariants([{ id: 0, tMs: 100, level: 1 }, { id: 0, tMs: 100, level: 1 }], s),
    ['client 0: shown 2 times at 100ms'],
  );
});

test('client with arrivals that never shows is a violation', () => {
  const s = mk(2, 2);
  assert.deepEqual(
    checkBurstInvariants([{ id: 0, tMs: 100, level: 1 }], s),
    ['client 1: never shown'],
  );
});
