import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatusLevels } from './index.mjs';

// 조각 key 는 시험용 문자열이다(이 모듈은 key 를 해석하지 않는다).
const P = (seg, lvl, n, counts) => counts.map((count, i) => ({ key: `s${seg}l${lvl}p${i}`, count }));

test('한 구간 0→1→2→3 도착은 매번 replace 이고 낮은 수준 key 는 drawKeys 에서 사라진다', () => {
  const sl = createStatusLevels();
  const sets = [[10, 20], [100, 200, 300], [1000], [5000, 6000]];
  const sums = [30, 600, 1000, 11000];
  const results = [];
  for (let lvl = 0; lvl < 4; lvl += 1) {
    const r = sl.arrive(2, lvl, P(2, lvl, 0, sets[lvl]));
    results.push(r.action);
    assert.equal(r.accepted, true);
    assert.equal(sl.renderPointCount(), sums[lvl]);
    assert.deepEqual(sl.drawKeys(), sets[lvl].map((_, i) => `s2l${lvl}p${i}`));
  }
  assert.deepEqual(results, ['first', 'replace', 'replace', 'replace']);
  assert.deepEqual(sl.released(), ['s2l0p0', 's2l0p1', 's2l1p0', 's2l1p1', 's2l1p2', 's2l2p0']);
  assert.deepEqual(sl.released(), []); // 한 번 읽으면 비운다
});

test('수준 3 이 먼저 오고 수준 1 이 늦게 오면 skip 이고 상태가 바뀌지 않는다', () => {
  const sl = createStatusLevels();
  sl.arrive(0, 3, P(0, 3, 0, [7, 8]));
  const before = JSON.stringify(sl.snapshots());
  const r = sl.arrive(0, 1, P(0, 1, 0, [1000]));
  assert.equal(r.accepted, false);
  assert.equal(r.action, 'skip');
  assert.equal(JSON.stringify(sl.snapshots()), before);
  assert.deepEqual(sl.drawKeys(), ['s0l3p0', 's0l3p1']);
  assert.equal(sl.renderPointCount(), 15);
  assert.deepEqual(sl.released(), []);
});

test('같은 수준 재도착도 skip', () => {
  const sl = createStatusLevels();
  sl.arrive(1, 2, P(1, 2, 0, [4]));
  const r = sl.arrive(1, 2, [{ key: 'other', count: 99 }]);
  assert.equal(r.accepted, false);
  assert.deepEqual(sl.drawKeys(), ['s1l2p0']);
  assert.equal(sl.renderPointCount(), 4);
  assert.deepEqual(sl.released(), []);
});

test('도착 전 expect 한 구간은 missing true, 점 0, drawKeys 에 없다', () => {
  const sl = createStatusLevels();
  sl.expect(5);
  sl.arrive(3, 0, P(3, 0, 0, [12]));
  const snaps = sl.snapshots();
  assert.deepEqual(snaps.map((s) => s.segmentId), [3, 5]);
  assert.equal(snaps[1].missing, true);
  assert.equal(snaps[1].level, -1);
  assert.equal(snaps[0].missing, false);
  assert.equal(sl.renderPointCount(), 12);
  assert.deepEqual(sl.drawKeys(), ['s3l0p0']);
});

test('3구간 x 4수준을 섞어 도착시켜도 구간마다 가장 높은 도착 수준이 남는다', () => {
  const sl = createStatusLevels();
  const order = [
    [2, 1], [0, 3], [1, 0], [2, 0], [1, 2], [0, 1], [2, 3], [1, 1], [0, 0], [2, 2], [0, 2], [1, 3],
  ];
  // 구간 s, 수준 l 의 조각은 count = 10^l 하나.
  for (const [s, l] of order) sl.arrive(s, l, [{ key: `s${s}l${l}`, count: 10 ** l }]);
  const snaps = sl.snapshots();
  assert.deepEqual(snaps.map((x) => [x.segmentId, x.level, x.final]), [[0, 3, true], [1, 3, true], [2, 3, true]]);
  assert.deepEqual(sl.drawKeys(), ['s0l3', 's1l3', 's2l3']);
  assert.equal(sl.renderPointCount(), 3000);
});

test('구간 번호 오름차순, 구간 안은 조각 입력 순서로 drawKeys 를 낸다', () => {
  const sl = createStatusLevels();
  sl.arrive(9, 0, [{ key: 'b', count: 1 }, { key: 'a', count: 2 }]);
  sl.arrive(4, 0, [{ key: 'z', count: 3 }]);
  assert.deepEqual(sl.drawKeys(), ['z', 'b', 'a']);
  assert.equal(sl.renderPointCount(), 6);
});

test('잘못된 입력은 TypeError/RangeError 이고 상태가 바뀌지 않는다', () => {
  const sl = createStatusLevels();
  sl.arrive(1, 1, [{ key: 'k', count: 5 }]);
  const before = JSON.stringify(sl.snapshots());
  assert.throws(() => sl.arrive(1, 4, [{ key: 'x', count: 1 }]), RangeError);
  assert.throws(() => sl.arrive(-1, 2, [{ key: 'x', count: 1 }]), RangeError);
  assert.throws(() => sl.arrive(1, 2, [{ key: 'x', count: NaN }]), (e) => e instanceof TypeError || e instanceof RangeError);
  assert.throws(() => sl.arrive(1, 2, 'no'), TypeError);
  assert.throws(() => sl.arrive(1, 2, [{ count: 1 }]), TypeError);
  assert.throws(() => sl.expect(-1), RangeError);
  assert.equal(JSON.stringify(sl.snapshots()), before);
  assert.deepEqual(sl.drawKeys(), ['k']);
  assert.deepEqual(sl.released(), []);
});
