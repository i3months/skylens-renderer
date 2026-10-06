import { test } from 'node:test';
import assert from 'assert';
import { createModeState } from './mode.mjs';
import { createTowerFallback } from './index.mjs';

test('mode: 처음은 live, 불 아닌 값은 TypeError', () => {
  const state = createModeState();
  // 초기값 live
  assert.strictEqual(state.mode(), 'live', 'Initial mode should be live');

  // 전환: live → fallback
  state.set(false);
  assert.strictEqual(state.mode(), 'fallback', 'After set(false), mode should be fallback');

  // 전환: fallback → live
  state.set(true);
  assert.strictEqual(state.mode(), 'live', 'After set(true), mode should be live');

  // 불 아닌 값은 TypeError(검사는 조립층 setAvailable 이 하고, 던진 뒤에도 모드는 그대로)
  const fb = createTowerFallback();
  for (const bad of [undefined, null, 0, 1, 'true', 'false', {}, [], NaN]) {
    assert.throws(() => fb.setAvailable(bad), TypeError, `setAvailable(${String(bad)})`);
    assert.strictEqual(fb.mode(), 'live');
  }
  fb.setAvailable(false);
  assert.throws(() => fb.setAvailable('x'), TypeError);
  assert.strictEqual(fb.mode(), 'fallback');
});

test('mode: 전환', () => {
  const state = createModeState();

  // live → fallback → live → fallback
  state.set(false);
  assert.strictEqual(state.mode(), 'fallback');

  state.set(true);
  assert.strictEqual(state.mode(), 'live');

  state.set(false);
  assert.strictEqual(state.mode(), 'fallback');
});
