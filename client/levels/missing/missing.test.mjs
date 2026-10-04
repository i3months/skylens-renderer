import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSegments, missingSegmentIds, MISSING_LABEL } from './index.mjs';

const absent = (segmentId) => ({ segmentId, level: -1, missing: true, final: false, pieces: [] });
const arrived = (segmentId, level, pieces) => ({ segmentId, level, missing: false, final: level === 3, pieces });

test('도착 전 구간은 렌더 점 0 이고 표시 상태가 참이다', () => {
  const [d] = describeSegments([absent(4)]);
  assert.deepEqual(d, { segmentId: 4, missing: true, renderPointCount: 0, label: '없음' });
  assert.equal(MISSING_LABEL, '없음');
});

test('도착 구간의 점 수는 조각 count 의 합이다', () => {
  const [d] = describeSegments([arrived(1, 2, [{ count: 100 }, { count: 250 }])]);
  assert.equal(d.renderPointCount, 350);
  assert.equal(d.missing, false);
  assert.notEqual(d.label, MISSING_LABEL);
});

test('count 가 없는 조각은 0 으로 센다', () => {
  const [d] = describeSegments([arrived(1, 0, [{ count: 7 }, {}, 'x'])]);
  assert.equal(d.renderPointCount, 7);
});

test('없음 구간이 이웃 값으로 채워지지 않고 번호도 빠지지 않는다', () => {
  const out = describeSegments([arrived(0, 3, [{ count: 500 }]), absent(1), arrived(2, 1, [{ count: 9 }])]);
  assert.deepEqual(out.map((d) => d.segmentId), [0, 1, 2]);
  assert.equal(out[1].renderPointCount, 0);
  assert.deepEqual(missingSegmentIds([absent(1), arrived(2, 1, [])]), [1]);
});

test('level 과 missing 이 어긋난 입력은 TypeError 로 거부한다', () => {
  assert.throws(() => describeSegments([{ ...absent(0), pieces: [{ count: 1 }] }]), TypeError);
  assert.throws(() => describeSegments([{ ...arrived(0, 1, []), missing: true }]), TypeError);
  assert.throws(() => describeSegments([{ ...absent(0), missing: false }]), TypeError);
  assert.throws(() => missingSegmentIds([{ ...absent(0), pieces: [{ count: 1 }] }]), TypeError);
  assert.throws(() => describeSegments('x'), TypeError);
});

test('입력을 바꾸지 않는다', () => {
  const states = [absent(0), arrived(1, 1, [{ count: 3 }, { count: 4 }])];
  const before = structuredClone(states);
  Object.freeze(states);
  describeSegments(states);
  missingSegmentIds(states);
  assert.deepEqual(states, before);
});

test('구간 100개 혼합의 정확한 값', () => {
  const states = [];
  let expected = 0;
  const missingIds = [];
  for (let i = 0; i < 100; i++) {
    if (i % 3 === 0) { states.push(absent(i)); missingIds.push(i); }
    else { states.push(arrived(i, i % 4, [{ count: i }, { count: 2 }])); expected += i + 2; }
  }
  const out = describeSegments(states);
  assert.equal(out.length, 100);
  assert.equal(out.reduce((s, d) => s + d.renderPointCount, 0), expected);
  assert.deepEqual(missingSegmentIds(states), missingIds);
  assert.equal(missingIds.length, 34);
  assert.ok(out.filter((d) => d.missing).every((d) => d.renderPointCount === 0 && d.label === '없음'));
});
