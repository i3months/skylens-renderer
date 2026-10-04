import test from 'node:test';
import assert from 'node:assert/strict';
import * as levels from './index.mjs';
import * as asset from '../asset/index.mjs';

test('F-181: 수준 상수는 contracts/asset 와 같은 객체', () => {
  assert.equal(levels.LEVEL_STEPS, asset.LEVEL_STEPS);
  assert.deepEqual([...levels.LEVEL_STEPS], [250, 1000, 3500, 7000]);
  assert.equal(levels.LEVEL_COUNT, 4);
  assert.equal(levels.SEGMENT_ID_LIMIT, asset.SEGMENT_ID_LIMIT);
});

test('F-181: 구간 번호 상한은 2^30 - 1', () => {
  assert.equal(levels.MAX_SEGMENT_ID, 2 ** 30 - 1);
  assert.doesNotThrow(() => levels.assertSegmentId(2 ** 30 - 1));
  assert.throws(() => levels.assertSegmentId(2 ** 30), RangeError);
  assert.throws(() => levels.assertSegmentId(0xffffffff), RangeError);
  assert.throws(() => levels.assertSegmentId(-1), RangeError);
});

test('F-178 ③: segmentId -0 은 거부(RangeError)', () => {
  assert.throws(() => levels.assertSegmentId(-0), RangeError);
  assert.doesNotThrow(() => levels.assertSegmentId(0));
});
