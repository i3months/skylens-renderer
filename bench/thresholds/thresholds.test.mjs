import test from 'node:test';
import assert from 'node:assert/strict';
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
