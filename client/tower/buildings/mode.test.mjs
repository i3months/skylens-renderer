// 표시 옵션 상태(createModeState) 시험: 기본값·전환·잘못된 값 RangeError 와 상태 불변.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModeState } from './mode.mjs';

test('기본 옵션은 black 이다', () => {
  assert.equal(createModeState().get(), 'black');
  assert.equal(createModeState(undefined).get(), 'black');
});

test('초기값 세 가지 모두 받는다', () => {
  assert.equal(createModeState('points').get(), 'points');
  assert.equal(createModeState('black').get(), 'black');
  assert.equal(createModeState('aerial').get(), 'aerial');
});

test('set 으로 세 옵션 사이를 오간다', () => {
  const m = createModeState();
  assert.equal(m.set('aerial'), undefined);
  assert.equal(m.get(), 'aerial');
  m.set('points');
  assert.equal(m.get(), 'points');
  m.set('black');
  assert.equal(m.get(), 'black');
  m.set('black');
  assert.equal(m.get(), 'black');
});

test('잘못된 옵션은 RangeError 이고 상태가 그대로다', () => {
  const m = createModeState('aerial');
  for (const bad of ['Black', 'POINTS', '', 'wire', null, undefined, 0, 1, ['black'], { mode: 'black' }]) {
    assert.throws(() => m.set(bad), (e) => e instanceof RangeError && e.message.startsWith('buildings:'), String(bad));
    assert.equal(m.get(), 'aerial');
  }
});

test('잘못된 초기값은 RangeError', () => {
  for (const bad of ['Aerial', 'none', null, 2, '']) {
    assert.throws(() => createModeState(bad), RangeError, String(bad));
  }
});

test('상태 객체끼리 독립이다', () => {
  const a = createModeState();
  const b = createModeState();
  a.set('points');
  assert.equal(a.get(), 'points');
  assert.equal(b.get(), 'black');
});
