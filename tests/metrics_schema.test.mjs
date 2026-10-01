import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, serialize, validateRecord } from '../contracts/metrics/index.mjs';

const sample = [{ metric: 'bundle.status.gzip', value: 123456, unit: 'B', device: 'ci', method: 'gzip-9', commit: '59edcf9' }];

test('metrics_schema_roundtrip', () => {
  const text = serialize(sample);
  assert.deepEqual(parse(text), sample);
  assert.equal(serialize(parse(text)), text);
  assert.ok(validateRecord({ ...sample[0], value: NaN }).length > 0);
  assert.ok(validateRecord({ ...sample[0], extra: 1 }).length > 0);
  assert.ok(validateRecord({ metric: 'x' }).length >= 5);
});

test('viewpoints_eight', () => {
  const v = JSON.parse(readFileSync(new URL('../fixtures/viewpoints/viewpoints.json', import.meta.url))).viewpoints;
  assert.equal(v.length, 8);
  assert.equal(new Set(v.map((x) => x.name)).size, 8);
});
