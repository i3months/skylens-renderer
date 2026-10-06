import test from 'node:test';
import assert from 'node:assert/strict';
import { perClientFromEvents } from './index.mjs';
import { FIXTURE_SCENARIO, FIXTURE_EVENTS } from '../../../contracts/load/harness.mjs';
import { validateResult } from '../../../contracts/load/index.mjs';

test('FIXTURE_EVENTS produces expected per-client results', () => {
  const result = perClientFromEvents(FIXTURE_EVENTS, 3);

  assert.equal(result.length, 3);

  assert.deepEqual(result[0], { id: 0, bytes: 5000, latencyMs: [100] });
  assert.deepEqual(result[1], { id: 1, bytes: 3000, latencyMs: [300] });
  assert.deepEqual(result[2], { id: 2, bytes: 1000, latencyMs: [900] });
});

test('client with no bytes events throws', () => {
  const eventsNoClient1 = FIXTURE_EVENTS.filter((e) => e.id !== 1);
  assert.throws(
    () => perClientFromEvents(eventsNoClient1, 3),
    (err) => err.message === 'client 1 has no bytes events'
  );
});

test('result with FIXTURE_SCENARIO and valid record passes validateResult', () => {
  const perClientData = perClientFromEvents(FIXTURE_EVENTS, FIXTURE_SCENARIO.clients);
  const record = {
    metric: 'load.first_frame_p95',
    value: 2100,
    unit: 'ms',
    device: 'headless',
    method: 'sim',
    commit: 'abcdef1',
  };
  const result = {
    scenario: FIXTURE_SCENARIO,
    records: [record],
    perClient: perClientData,
  };

  const errors = validateResult(result);
  assert.deepEqual(errors, []);
});

test('returns array of exactly clients entries', () => {
  for (const clients of [1, 3, 5]) {
    const events = [];
    for (let id = 0; id < clients; id++) {
      events.push({ id, tMs: 1000, kind: 'bytes', bytes: 1000 * (id + 1), latencyMs: 100 + id * 10 });
    }
    const result = perClientFromEvents(events, clients);
    assert.equal(result.length, clients);
    for (let i = 0; i < clients; i++) {
      assert.equal(result[i].id, i);
    }
  }
});

test('never leaves array holes', () => {
  const events = [
    { id: 0, tMs: 1000, kind: 'bytes', bytes: 1000, latencyMs: 100 },
    { id: 1, tMs: 1100, kind: 'bytes', bytes: 2000, latencyMs: 200 },
    { id: 2, tMs: 1200, kind: 'bytes', bytes: 3000, latencyMs: 300 },
  ];
  const result = perClientFromEvents(events, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(Object.hasOwn(result, i), `index ${i} should exist`);
  }
});

test('sums bytes correctly for multiple bytes events per client', () => {
  const events = [
    { id: 0, tMs: 1000, kind: 'bytes', bytes: 1000, latencyMs: 100 },
    { id: 0, tMs: 2000, kind: 'bytes', bytes: 2000, latencyMs: 150 },
    { id: 0, tMs: 3000, kind: 'bytes', bytes: 500, latencyMs: 200 },
  ];
  const result = perClientFromEvents(events, 1);
  assert.equal(result[0].bytes, 3500);
  assert.deepEqual(result[0].latencyMs, [100, 150, 200]);
});

test('preserves latencyMs order', () => {
  const events = [
    { id: 0, tMs: 3000, kind: 'bytes', bytes: 100, latencyMs: 300 },
    { id: 0, tMs: 1000, kind: 'bytes', bytes: 100, latencyMs: 100 },
    { id: 0, tMs: 2000, kind: 'bytes', bytes: 100, latencyMs: 200 },
  ];
  const result = perClientFromEvents(events, 1);
  assert.deepEqual(result[0].latencyMs, [300, 100, 200]);
});

test('ignores non-bytes events', () => {
  const events = [
    { id: 0, tMs: 0, kind: 'connect' },
    { id: 0, tMs: 1000, kind: 'bytes', bytes: 5000, latencyMs: 100 },
    { id: 0, tMs: 1200, kind: 'first_frame' },
    { id: 0, tMs: 9000, kind: 'close' },
  ];
  const result = perClientFromEvents(events, 1);
  assert.deepEqual(result[0], { id: 0, bytes: 5000, latencyMs: [100] });
});
