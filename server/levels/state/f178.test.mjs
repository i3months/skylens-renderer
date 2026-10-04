import test from 'node:test';
import assert from 'node:assert/strict';
import { createLevelMachine } from './index.mjs';
import { createPieceLedger } from '../replace/index.mjs';

test('F-178 ①: 정의역 밖 count 는 arrive 에서 거부, 상태 불변', () => {
  const bad = [
    [[{ count: 10 }, { count: -4 }], RangeError],
    [[{ count: 1.5 }], TypeError],
    [[{ count: NaN }], TypeError],
    [[{ count: Infinity }], TypeError],
    [[{ count: '3' }], TypeError],
    [[{ count: null }], TypeError],
    [[{ count: 2 ** 53 }], RangeError],
    [[{ count: Number.MAX_SAFE_INTEGER }, { count: 1 }], RangeError],
  ];
  for (const [pieces, Err] of bad) {
    const m = createLevelMachine();
    assert.throws(() => m.arrive(1, 0, pieces), Err);
    assert.equal(m.snapshot(1).level, -1);
    assert.equal(m.pointCount(1), 0);
  }
  const m = createLevelMachine();
  assert.throws(() => m.arrive(1, 0, [{ count: 1e308 }, { count: 1e308 }]), RangeError);
});

test('F-178 ①: 정상 count 합, -0 은 0', () => {
  const m = createLevelMachine();
  m.arrive(1, 0, [{ count: 10 }, { count: 0 }, {}, { count: -0 }]);
  assert.equal(m.pointCount(1), 10);
  m.arrive(2, 0, [{ count: -0 }]);
  assert.ok(Object.is(m.pointCount(2), 0));
});

test('F-178 ②: 첫 콜백이 던져도 콜백 3회, 첫 오류를 던진다', () => {
  const m = createLevelMachine();
  const calls = [];
  const errs = [new Error('e1'), new Error('e2'), new Error('e3')];
  const ledger = createPieceLedger(m, {
    onRelease(p) { calls.push(p.id); throw errs[p.id]; },
  });
  ledger.arrive(7, 0, [{ id: 0, count: 1 }, { id: 1, count: 1 }, { id: 2, count: 1 }]);
  assert.throws(() => ledger.arrive(7, 1, [{ id: 9, count: 1 }]), (e) => e === errs[0]);
  assert.deepEqual(calls, [0, 1, 2]);
  assert.equal(ledger.heldPieceCount(7), 1);
});

test('F-178 ②: 첫 콜백만 던져도 나머지 호출, 오류 없으면 던지지 않음', () => {
  const m = createLevelMachine();
  let n = 0;
  const ledger = createPieceLedger(m, { onRelease() { n++; if (n === 1) throw new TypeError('x'); } });
  ledger.arrive(1, 0, [{}, {}, {}]);
  assert.throws(() => ledger.arrive(1, 1, []), TypeError);
  assert.equal(n, 3);
  ledger.arrive(2, 0, [{}]);
  assert.doesNotThrow(() => ledger.arrive(2, 1, []));
});

test('F-178 ③: -0 구간 번호는 RangeError', () => {
  const m = createLevelMachine();
  assert.throws(() => m.arrive(-0, 0), RangeError);
  assert.equal(Object.is(m.arrive(0, 0).segmentId, 0), true);
});
