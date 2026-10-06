import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateClients } from './index.mjs';
import { validateEvent } from '../../../contracts/load/harness.mjs';

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

test('burst levels arrive together; slow link adds latency', () => {
  const b = simulateClients({ ...steady(1), kind: 'burst', burstLevels: 4 }, { seed: 2 });
  const times = b.filter((e) => e.kind === 'level').map((e) => e.tMs);
  assert.ok(Math.max(...times) - Math.min(...times) <= 100 * 4);
  const slow = simulateClients({ ...steady(1), kind: 'slow_link', linkBytesPerS: 10000 }, { seed: 2 });
  assert.ok(Math.max(...slow.filter((e) => e.kind === 'bytes').map((e) => e.latencyMs)) > 5000);
});
