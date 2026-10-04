import test from 'node:test';
import assert from 'node:assert/strict';
import { createLevelMachine } from './index.mjs';

test('first·replace·skip 와 조각 해제', () => {
  const m = createLevelMachine();
  const a = { count: 10 }, b = { count: 40 };
  let r = m.arrive(5, 1, [a]);
  assert.deepEqual([r.action, r.previousLevel, r.accepted, r.released.length], ['first', -1, true, 0]);
  r = m.arrive(5, 3, [b]);
  assert.deepEqual([r.action, r.previousLevel, r.released], ['replace', 1, [a]]);
  r = m.arrive(5, 2, [{ count: 99 }]);
  assert.deepEqual([r.action, r.accepted, r.released.length], ['skip', false, 0]);
  r = m.arrive(5, 3, [{ count: 99 }]);
  assert.equal(r.action, 'skip');
  const s = m.snapshot(5);
  assert.deepEqual([s.level, s.missing, s.final, s.pieces], [3, false, true, [b]]);
  assert.equal(m.pointCount(5), 40);
});

test('없음: 모르는 구간·expect', () => {
  const m = createLevelMachine();
  assert.deepEqual(m.snapshot(9), { segmentId: 9, level: -1, missing: true, final: false, pieces: [] });
  assert.deepEqual(m.segments(), []);
  m.expect(9); m.expect(2);
  assert.deepEqual(m.segments(), [2, 9]);
  assert.equal(m.pointCount(9), 0);
  m.arrive(9, 0, [{ count: 3 }]);
  m.expect(9);
  assert.equal(m.snapshot(9).level, 0);
});

test('구간은 서로 독립', () => {
  const m = createLevelMachine();
  m.arrive(1, 3, []); m.arrive(2, 0, []);
  assert.equal(m.snapshot(1).level, 3);
  assert.equal(m.snapshot(2).level, 0);
});

test('입력 검사와 기록', () => {
  const m = createLevelMachine({ recordHistory: true });
  assert.throws(() => m.arrive(-1, 0), RangeError);
  assert.throws(() => m.arrive(0, 4), RangeError);
  assert.throws(() => m.arrive(0, 0, 'x'), TypeError);
  m.arrive(0, 2); m.arrive(0, 1);
  assert.deepEqual(m.history(), [{ seq: 0, segmentId: 0, level: 2, action: 'first' }, { seq: 1, segmentId: 0, level: 1, action: 'skip' }]);
  assert.deepEqual(createLevelMachine().history(), []);
});
