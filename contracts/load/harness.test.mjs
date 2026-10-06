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
