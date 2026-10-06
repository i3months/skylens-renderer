import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, rng, FIXTURE_EVENTS, FIXTURE_SCENARIO } from './harness.mjs';
import { validateScenario } from './index.mjs';

test('T16.0b: 픽스처가 계약을 만족', () => {
  assert.deepEqual(validateScenario(FIXTURE_SCENARIO), []);
  for (const e of FIXTURE_EVENTS) assert.deepEqual(validateEvent(e, 3), []);
});
test('T16.0b: 이벤트 음성', () => {
  assert.deepEqual(validateEvent({ id: 3, tMs: 0, kind: 'connect' }, 3), ['bad id']);
  assert.deepEqual(validateEvent({ id: 0, tMs: -1, kind: 'connect' }, 3), ['bad tMs']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'x' }, 3), ['bad kind']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'bytes', bytes: 1.5, latencyMs: -1 }, 3), ['bad bytes', 'bad latencyMs']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'level', level: 4 }, 3), ['bad level']);
  assert.deepEqual(validateEvent(null, 3), ['event must be an object']);
});
test('T16.0b: rng 결정적', () => {
  const a = rng(7); const b = rng(7);
  const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notEqual(rng(8)(), xs[0]);
});

test('T16.0b: validateEvent id/이벤트 형태 음성', () => {
  const ok = { tMs: 0, kind: 'connect' };
  for (const id of [-1, 1.5, 3, '0', NaN, undefined]) assert.deepEqual(validateEvent({ ...ok, id }, 3), ['bad id']);
  assert.deepEqual(validateEvent({ ...ok, id: 2 }, 3), []);
  assert.deepEqual(validateEvent({ ...ok, id: 0 }, 3), []);
  for (const e of [[], null, 'connect', 5, undefined]) assert.deepEqual(validateEvent(e, 3), ['event must be an object']);
});
test('T16.0b: validateEvent level/tMs/kind/bytes/latencyMs 음성과 양성', () => {
  const lv = (level) => ({ id: 0, tMs: 0, kind: 'level', level });
  for (const level of [-1, 4, 1.5]) assert.deepEqual(validateEvent(lv(level), 3), ['bad level']);
  for (const level of [0, 3]) assert.deepEqual(validateEvent(lv(level), 3), []);
  for (const tMs of [NaN, Infinity, -1]) assert.deepEqual(validateEvent({ id: 0, tMs, kind: 'connect' }, 3), ['bad tMs']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'bogus' }, 3), ['bad kind']);
  const by = (bytes, latencyMs) => ({ id: 0, tMs: 0, kind: 'bytes', bytes, latencyMs });
  for (const bytes of [-1, 1.5]) assert.deepEqual(validateEvent(by(bytes, 0), 3), ['bad bytes']);
  for (const latencyMs of [NaN, -1, Infinity]) assert.deepEqual(validateEvent(by(0, latencyMs), 3), ['bad latencyMs']);
  assert.deepEqual(validateEvent(by(0, 0), 3), []);
});
test('T16.0b: validateEvent kind 별 허용 키', () => {
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'connect', bytes: 1 }, 3), ['unexpected key bytes']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'close', level: 0 }, 3), ['unexpected key level']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'first_frame', latencyMs: 1 }, 3), ['unexpected key latencyMs']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'level', level: 1, bytes: 1 }, 3), ['unexpected key bytes']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'bytes', bytes: 1, latencyMs: 1, level: 1 }, 3), ['unexpected key level']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'connect', extra: 1, more: 2 }, 3), ['unexpected key extra', 'unexpected key more']);
});
test('T16.0b: rng(7) 첫 3값 고정', () => {
  const r = rng(7);
  assert.deepEqual([r(), r(), r()], [0.011704753153026104, 0.06195825757458806, 0.97690763277933]);
});
test('T16.0b: rng seed 는 0..2^32-1 정수만', () => {
  for (const s of [1.7, -1, 2 ** 32, NaN, Infinity, '7', null, undefined]) assert.throws(() => rng(s), RangeError);
  assert.doesNotThrow(() => rng(0));
  assert.doesNotThrow(() => rng(2 ** 32 - 1));
});
