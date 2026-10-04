import test from 'node:test';
import assert from 'node:assert';
import { missingNotices } from './index.mjs';

test('missingNotices - basic case: mixed arrived and missing segments', () => {
  const states = [
    { segmentId: 0, level: 2, missing: false, pieces: [] },
    { segmentId: 1, level: -1, missing: true, pieces: [] },
    { segmentId: 2, level: -1, missing: true, pieces: [] },
    { segmentId: 3, level: 0, missing: false, pieces: [] },
  ];
  const result = missingNotices(states);
  const expected = [
    { segmentId: 1, text: '없음' },
    { segmentId: 2, text: '없음' },
  ];
  assert.deepEqual(result, expected);
});

test('missingNotices - all arrived', () => {
  const states = [
    { segmentId: 0, level: 0, missing: false, pieces: [] },
    { segmentId: 1, level: 1, missing: false, pieces: [] },
    { segmentId: 2, level: 2, missing: false, pieces: [] },
  ];
  const result = missingNotices(states);
  assert.deepEqual(result, []);
});

test('missingNotices - all missing', () => {
  const states = [
    { segmentId: 0, level: -1, missing: true, pieces: [] },
    { segmentId: 1, level: -1, missing: true, pieces: [] },
    { segmentId: 2, level: -1, missing: true, pieces: [] },
    { segmentId: 3, level: -1, missing: true, pieces: [] },
  ];
  const result = missingNotices(states);
  assert.equal(result.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(result[i].segmentId, i);
    assert.equal(result[i].text, '없음');
  }
});

test('missingNotices - mismatched level and missing', () => {
  const states = [
    { segmentId: 0, level: 0, missing: true, pieces: [] }, // mismatched: level is 0 but missing is true
  ];
  assert.throws(() => missingNotices(states), TypeError);
});

test('missingNotices - input not an array', () => {
  assert.throws(() => missingNotices({ segmentId: 0 }), TypeError);
});

test('missingNotices - input immutability and frozen input', () => {
  const states = [
    { segmentId: 0, level: -1, missing: true, pieces: [] },
    { segmentId: 1, level: 0, missing: false, pieces: [] },
  ];
  Object.freeze(states);
  const result = missingNotices(states);
  assert.deepEqual(result, [{ segmentId: 0, text: '없음' }]);
  // Verify that the input is still frozen and unchanged
  assert.equal(Object.isFrozen(states), true);
  assert.equal(states[0].level, -1);
  assert.equal(states[1].level, 0);
});

test('missingNotices - empty input', () => {
  const states = [];
  const result = missingNotices(states);
  assert.deepEqual(result, []);
});

test('missingNotices - order preservation', () => {
  const states = [
    { segmentId: 5, level: -1, missing: true, pieces: [] },
    { segmentId: 2, level: 1, missing: false, pieces: [] },
    { segmentId: 8, level: -1, missing: true, pieces: [] },
    { segmentId: 3, level: -1, missing: true, pieces: [] },
  ];
  const result = missingNotices(states);
  const expected = [
    { segmentId: 5, text: '없음' },
    { segmentId: 8, text: '없음' },
    { segmentId: 3, text: '없음' },
  ];
  assert.deepEqual(result, expected);
});
