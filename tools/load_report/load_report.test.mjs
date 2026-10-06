import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReport } from './index.mjs';

test('loadReport: basic functionality with 2 clients and 2 records', () => {
  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 2,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'throughput',
        value: 1500,
        unit: 'B',
        device: 'test_device',
        method: 'measure',
        commit: 'abc1234567890',
      },
      {
        metric: 'latency_p95',
        value: 45.5,
        unit: 'ms',
        device: 'test_device',
        method: 'measure',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
      { id: 1, bytes: 3000, latencyMs: [50, 52] },
    ],
  };

  const output = loadReport(result);
  const expected = [
    '| metric | value | unit | device | method |',
    '| --- | --- | --- | --- | --- |',
    '| throughput | 1500 | B | test_device | measure |',
    '| latency_p95 | 45.5 | ms | test_device | measure |',
    '',
    'clients: 2, total bytes: 8000',
  ].join('\n');

  assert.equal(output, expected);
});

test('loadReport: throws on invalid result (clients mismatch)', () => {
  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 2,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'throughput',
        value: 1500,
        unit: 'B',
        device: 'test_device',
        method: 'measure',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  assert.throws(() => loadReport(result), /perClient length != clients/);
});
