import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkThresholds, loadThresholds } from './index.mjs';

const rec = (metric, value) => ({ metric, value, unit: 'ms', device: 'd', method: 'm', commit: 'abcdef1' });

test('over max', () => {
  assert.deepEqual(checkThresholds([rec('a', 11)], { a: { max: 10 } }), ['a: 11 > max 10']);
});
test('under min', () => {
  assert.deepEqual(checkThresholds([rec('a', 1)], { a: { min: 2 } }), ['a: 1 < min 2']);
});
test('missing metric', () => {
  assert.deepEqual(checkThresholds([rec('b', 1)], { a: { max: 10 } }), ['a: missing']);
});
test('equality at the limit passes', () => {
  assert.deepEqual(checkThresholds([rec('a', 10), rec('c', 2)], { a: { max: 10 }, c: { min: 2 } }), []);
});
test('unlisted metrics are ignored', () => {
  assert.deepEqual(checkThresholds([rec('a', 5), rec('z', 1e9)], { a: { max: 10 } }), []);
});
test('invalid thresholds throw', () => {
  assert.throws(() => checkThresholds([], { a: {} }), Error);
  assert.throws(() => checkThresholds([], { a: { max: NaN } }), Error);
  assert.throws(() => checkThresholds([], { a: { min: Infinity } }), Error);
  assert.throws(() => checkThresholds([], { a: { max: '3' } }), Error);
  assert.throws(() => checkThresholds([], { a: null }), Error);
});
test('thresholds.json parses and is accepted', () => {
  const t = loadThresholds();
  assert.deepEqual(t, { 'load.first_frame_p95': { max: 3000 } });
  assert.deepEqual(checkThresholds([rec('load.first_frame_p95', 2100)], t), []);
  assert.deepEqual(checkThresholds([rec('load.first_frame_p95', 3001)], t), ['load.first_frame_p95: 3001 > max 3000']);
});

test('non-numeric values are violations', () => {
  for (const v of [undefined, null, '5', NaN, {}, true]) {
    assert.deepEqual(checkThresholds([rec('a', v)], { a: { max: 10 } }), ['a: non-numeric value']);
    assert.deepEqual(checkThresholds([rec('a', v)], { a: { min: 2 } }), ['a: non-numeric value']);
  }
  assert.deepEqual(checkThresholds([{ metric: 'a' }], { a: { max: 10 } }), ['a: non-numeric value']);
});
test('Infinity is an ordinary over-max violation', () => {
  assert.deepEqual(checkThresholds([rec('a', Infinity)], { a: { max: 10 } }), ['a: Infinity > max 10']);
  assert.deepEqual(checkThresholds([rec('a', -Infinity)], { a: { min: 2 } }), ['a: -Infinity < min 2']);
});
test('every record of a metric is checked', () => {
  assert.deepEqual(checkThresholds([rec('a', 5), rec('a', 11)], { a: { max: 10 } }), ['a: 11 > max 10']);
  assert.deepEqual(checkThresholds([rec('a', 11), rec('a', 5)], { a: { max: 10 } }), ['a: 11 > max 10']);
  assert.deepEqual(checkThresholds([rec('a', 11), rec('a', 12)], { a: { max: 10 } }), ['a: 11 > max 10', 'a: 12 > max 10']);
  assert.deepEqual(checkThresholds([rec('a', 5), rec('a', NaN), rec('a', 5)], { a: { max: 10 } }), ['a: non-numeric value']);
});
test('boundary: value == max passes, just above fails', () => {
  assert.deepEqual(checkThresholds([rec('a', 10)], { a: { max: 10 } }), []);
  assert.deepEqual(checkThresholds([rec('a', 10.001)], { a: { max: 10 } }), ['a: 10.001 > max 10']);
  assert.deepEqual(checkThresholds([rec('a', 2)], { a: { min: 2 } }), []);
  assert.deepEqual(checkThresholds([rec('a', 1.999)], { a: { min: 2 } }), ['a: 1.999 < min 2']);
});
test('metric without a threshold passes, even when non-numeric', () => {
  assert.deepEqual(checkThresholds([rec('z', NaN), rec('z', undefined)], { a: { max: 10 } }), ['a: missing']);
  assert.deepEqual(checkThresholds([rec('a', 1), rec('z', NaN)], { a: { max: 10 } }), []);
});
test('input validation errors', () => {
  const th = { a: { max: 10 } };
  for (const bad of [undefined, null, {}, 'x', 5]) {
    assert.throws(() => checkThresholds(bad, th), { name: 'Error', message: 'records must be an array' });
  }
  assert.throws(() => checkThresholds([rec('a', 1), null], th), { message: 'records[1] must be an object' });
  assert.throws(() => checkThresholds([5], th), { message: 'records[0] must be an object' });
  assert.throws(() => checkThresholds(['a'], th), { message: 'records[0] must be an object' });
  assert.throws(() => checkThresholds([[]], th), { message: 'records[0] must be an object' });
  for (const bad of [undefined, null, [], 'x', 3]) {
    assert.throws(() => checkThresholds([], bad), { message: 'thresholds must be an object' });
  }
});

test('checkThresholds rejects empty thresholds object', () => {
  assert.throws(() => checkThresholds([], {}), { message: 'thresholds object must not be empty' });
});

test('checkThresholds validation: rejects missing max/min', () => {
  // Test that checkThresholds rejects thresholds without max/min
  const invalidThresholds = { 'load.metric': {} };
  assert.throws(() => checkThresholds([], invalidThresholds), { message: 'load.metric: threshold needs max or min' });
});

test('checkThresholds validation: rejects invalid numeric values', () => {
  // Test that checkThresholds rejects thresholds with non-numeric max/min
  assert.throws(() => checkThresholds([], { 'load.metric': { max: 'not_a_number' } }),
    { message: 'load.metric: max must be a finite number' });
  assert.throws(() => checkThresholds([], { 'load.metric': { min: NaN } }),
    { message: 'load.metric: min must be a finite number' });
  assert.throws(() => checkThresholds([], { 'load.metric': { max: Infinity } }),
    { message: 'load.metric: max must be a finite number' });
  assert.throws(() => checkThresholds([], { 'load.metric': { min: -Infinity } }),
    { message: 'load.metric: min must be a finite number' });
});

test('checkThresholds validation: rejects non-object threshold values', () => {
  // Test that checkThresholds rejects non-object threshold entries
  for (const bad of [null, 'string', 42, [], true]) {
    assert.throws(() => checkThresholds([], { 'load.metric': bad }),
      { message: 'load.metric: threshold must be an object' });
  }
});

test('loadThresholds validates the file it reads (path injection)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thr-'));
  try {
    const write = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
    assert.throws(() => loadThresholds(write('empty.json', '{}')), { message: 'thresholds object must not be empty' });
    assert.throws(() => loadThresholds(write('nomax.json', '{"a":{}}')), { message: 'a: threshold needs max or min' });
    assert.throws(() => loadThresholds(write('arr.json', '[]')), { message: 'thresholds must be an object' });
    assert.deepEqual(loadThresholds(write('ok.json', '{"a":{"max":1}}')), { a: { max: 1 } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
