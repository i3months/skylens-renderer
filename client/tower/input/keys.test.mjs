import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyTracker } from './keys.mjs';

const NONE = { yawLeft: false, yawRight: false, forward: false, back: false, altUp: false, altDown: false };

test('keys: 반복 keyDown 은 무시되고 keyUp 한 번으로 뗀다', () => {
  const k = createKeyTracker();
  assert.equal(k.down('ArrowUp'), true);
  assert.equal(k.down('ArrowUp'), true);
  assert.equal(k.down('ArrowUp'), true);
  assert.deepEqual(k.held(), { ...NONE, forward: true });
  assert.equal(k.up('ArrowUp'), true);
  assert.deepEqual(k.held(), NONE);
});

test('keys: 모르는 키는 false 이고 상태 불변', () => {
  const k = createKeyTracker();
  k.down('KeyE');
  for (const c of ['KeyZ', '', 'arrowup', undefined, null, 5, {}, ['ArrowUp'], Symbol('x')]) {
    assert.equal(k.down(c), false);
    assert.equal(k.up(c), false);
  }
  assert.deepEqual(k.held(), { ...NONE, altUp: true });
});

test('keys: Object.prototype 키(constructor, __proto__ 등)는 모르는 키', () => {
  const k = createKeyTracker();
  for (const c of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']) {
    assert.equal(k.down(c), false);
    assert.equal(k.up(c), false);
  }
  assert.deepEqual(k.held(), NONE);
});

test('keys: 반대 키는 상쇄하지 않고 둘 다 true', () => {
  const k = createKeyTracker();
  k.down('ArrowLeft'); k.down('ArrowRight'); k.down('KeyQ'); k.down('KeyE');
  assert.deepEqual(k.held(), { ...NONE, yawLeft: true, yawRight: true, altUp: true, altDown: true });
});

test('keys: releaseAll 은 모든 키를 뗀다', () => {
  const k = createKeyTracker();
  for (const c of ['ArrowLeft', 'ArrowUp', 'KeyQ']) k.down(c);
  k.releaseAll();
  assert.deepEqual(k.held(), NONE);
  k.releaseAll();
  assert.deepEqual(k.held(), NONE);
  assert.equal(k.down('ArrowUp'), true);
  assert.deepEqual(k.held(), { ...NONE, forward: true });
});

test('keys: held 는 새 객체이고 바꿔도 상태 불변', () => {
  const k = createKeyTracker();
  k.down('ArrowDown');
  const h = k.held();
  h.back = false; h.forward = true;
  assert.notEqual(k.held(), h);
  assert.deepEqual(k.held(), { ...NONE, back: true });
});

test('keys: 눌리지 않은 키의 up 은 true 이고 상태 불변', () => {
  const k = createKeyTracker();
  assert.equal(k.up('ArrowLeft'), true);
  assert.deepEqual(k.held(), NONE);
});
