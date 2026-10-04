import test from 'node:test';
import assert from 'node:assert/strict';
import { createLevelMachine } from './index.mjs';
import { createLevelMachine as serverMachine } from '../../server/levels/state/index.mjs';
import { describeSegments } from './missing/index.mjs';

test('F-178 ①: 정의역 밖 count 는 서버·클라이언트가 같은 오류로 거부', () => {
  const bad = [
    [[{ count: 10 }, { count: -4 }], RangeError],
    [[{ count: 1e308 }, { count: 1e308 }], RangeError],
    [[{ count: 2.5 }], TypeError],
    [[{ count: NaN }], TypeError],
    [[{ count: Number.MAX_SAFE_INTEGER }, { count: 1 }], RangeError],
  ];
  for (const [pieces, Err] of bad) {
    for (const make of [createLevelMachine, serverMachine]) {
      const m = make();
      assert.throws(() => m.arrive(3, 1, pieces), Err);
      assert.equal(m.snapshot(3).level, -1);
    }
  }
});

test('F-178 ①: pointCount === renderPointCount', () => {
  const m = createLevelMachine();
  m.arrive(4, 2, [{ count: 10 }, { count: 0 }, { count: -0 }, {}, { count: 7 }]);
  const [d] = describeSegments([m.snapshot(4)]);
  assert.equal(m.pointCount(4), 17);
  assert.equal(d.renderPointCount, 17);
  assert.ok(Object.is(describeSegments([{ segmentId: 5, level: 0, missing: false, final: false, pieces: [{ count: -0 }] }])[0].renderPointCount, 0));
});

test('F-178 ①: 표시 쪽도 정의역 밖 count 는 던진다(갈라지지 않음)', () => {
  const st = (pieces) => [{ segmentId: 1, level: 0, missing: false, final: false, pieces }];
  assert.throws(() => describeSegments(st([{ count: 10 }, { count: -4 }])), RangeError);
  assert.throws(() => describeSegments(st([{ count: 1.5 }])), TypeError);
});

test('F-178 ③: -0 구간 번호는 RangeError', () => {
  assert.throws(() => createLevelMachine().arrive(-0, 0), RangeError);
});
