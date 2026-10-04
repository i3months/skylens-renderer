import test from 'node:test';
import assert from 'node:assert/strict';
import { computeReveal } from './index.mjs';

const absent = (segmentId) => ({ segmentId, level: -1, missing: true, final: false, pieces: [] });
const arrived = (segmentId, level, pieces) => ({ segmentId, level, missing: false, final: level === 3, pieces });
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

test('도착 전 구간은 hidden 에만 들고 점 0 이다', () => {
  const r = computeReveal([absent(5)]);
  assert.deepEqual(r, { visible: [], hidden: [5], renderPointCount: 0 });
});

test('3구간 중 1개만 도착하면 그 구간 count 합만 센다', () => {
  const r = computeReveal([absent(0), arrived(1, 2, [{ count: 100 }, { count: 250 }]), absent(2)]);
  assert.deepEqual(r.visible, [1]);
  assert.deepEqual(r.hidden, [0, 2]);
  assert.equal(r.renderPointCount, 350);
});

test('모든 구간이 도착 전이면 visible 비고 점 0', () => {
  const r = computeReveal([absent(0), absent(1), absent(2)]);
  assert.deepEqual(r, { visible: [], hidden: [0, 1, 2], renderPointCount: 0 });
});

test('빈 입력도 허용한다', () => {
  assert.deepEqual(computeReveal([]), { visible: [], hidden: [], renderPointCount: 0 });
});

test('입력 순서를 유지한다', () => {
  const r = computeReveal([arrived(2, 0, [{ count: 4 }]), absent(0), arrived(1, 3, [{ count: 6 }])]);
  assert.deepEqual(r.visible, [2, 1]);
  assert.deepEqual(r.hidden, [0]);
  assert.equal(r.renderPointCount, 10);
});

test('입력을 바꾸지 않는다(freeze 입력)', () => {
  const input = deepFreeze([arrived(1, 1, [{ count: 3 }]), absent(0)]);
  const copy = JSON.parse(JSON.stringify(input));
  const r = computeReveal(input);
  assert.deepEqual(input, copy);
  assert.equal(r.renderPointCount, 3);
});

test('잘못된 입력은 TypeError', () => {
  assert.throws(() => computeReveal(null), TypeError);
  assert.throws(() => computeReveal([null]), TypeError);
  assert.throws(() => computeReveal([{ segmentId: 1, level: 0, missing: true, final: false, pieces: [] }]), TypeError);
  assert.throws(() => computeReveal([{ segmentId: 1, level: -1, missing: false, final: false, pieces: [] }]), TypeError);
  assert.throws(() => computeReveal([{ segmentId: 1, level: -1, missing: true, final: false, pieces: [{ count: 1 }] }]), TypeError);
});

test('구간 번호 중복은 TypeError', () => {
  assert.throws(() => computeReveal([arrived(1, 0, [{ count: 5 }]), arrived(1, 1, [{ count: 5 }])]), TypeError);
  assert.throws(() => computeReveal([absent(2), absent(2)]), TypeError);
});

test('renderPointCount 가 안전 정수를 넘으면 RangeError', () => {
  const maxSafe = Number.MAX_SAFE_INTEGER;
  // 두 조각의 count 합이 MAX_SAFE_INTEGER를 넘기도록 구성
  assert.throws(() => computeReveal([arrived(0, 0, [{ count: maxSafe - 100 }]), arrived(1, 1, [{ count: 200 }])]), RangeError);
});

test('renderPointCount 합이 정확히 MAX_SAFE_INTEGER 이면 받는다(경계 포함)', () => {
  const maxSafe = Number.MAX_SAFE_INTEGER;
  const r = computeReveal([arrived(0, 0, [{ count: maxSafe - 200 }]), arrived(1, 1, [{ count: 200 }])]);
  assert.equal(r.renderPointCount, maxSafe);
  assert.deepEqual(r.visible, [0, 1]);
  // 한 조각이 정확히 MAX_SAFE_INTEGER 인 경우도 받는다
  assert.equal(computeReveal([arrived(0, 0, [{ count: maxSafe }])]).renderPointCount, maxSafe);
  // 1 만 더해도 거부한다
  assert.throws(() => computeReveal([arrived(0, 0, [{ count: maxSafe - 200 }]), arrived(1, 1, [{ count: 201 }])]), RangeError);
});
