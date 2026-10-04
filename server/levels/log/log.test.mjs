import test from 'node:test';
import assert from 'node:assert/strict';
import { createLevelMachine } from '../state/index.mjs';
import { formatHistory, replayHistory } from './index.mjs';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 열마다 새 기계(F-180 ①): 기계 하나에 긴 열을 먹이면 구간당 replace 가 최대 3 번이라 이력이 거의 skip 뿐이다.
//   200열 × 구간 2개 × 도착 5건 = 1000건. 구간당 k=2.5 건 평균, 기대 replace 는 k=2 에서 0.375, k=3 에서 0.59375
//   → 구간당 약 0.48, 열당 약 0.97, 합 약 190. 하한 100 은 그 절반쯤이다.
test('200열(열마다 새 기계) 1000개 도착의 이력이 입력 열과 순서·구간·수준 일치, seq 0..n-1', () => {
  const r = rng(0x10c0de);
  const total = { first: 0, replace: 0, skip: 0 };
  let arrivals = 0;
  for (let col = 0; col < 200; col++) {
    const m = createLevelMachine({ recordHistory: true });
    const input = [];
    for (let i = 0; i < 5; i++) {
      const segmentId = Math.floor(r() * 2);
      const level = Math.floor(r() * 4);
      input.push({ segmentId, level });
      m.arrive(segmentId, level);
    }
    const h = m.history();
    assert.equal(h.length, 5);
    h.forEach((e, i) => assert.equal(e.seq, i));
    assert.deepEqual(replayHistory(h), input);
    for (const e of h) total[e.action]++;
    arrivals += h.length;
  }
  assert.equal(arrivals, 1000);
  assert.equal(total.first + total.replace + total.skip, 1000);
  assert.ok(total.replace >= 100, JSON.stringify(total));
  assert.ok(total.first >= 300, JSON.stringify(total));
  assert.ok(total.skip >= 300, JSON.stringify(total));
});

test('손으로 쓴 도착 열의 action 열', () => {
  const m = createLevelMachine({ recordHistory: true });
  // 구간 0: 1(first) 0(skip) 1(skip) 2(replace) 3(replace) 3(skip) / 구간 1: 0(first) 3(replace)
  const seq = [[0, 1], [0, 0], [0, 1], [0, 2], [1, 0], [0, 3], [0, 3], [1, 3]];
  for (const [seg, lv] of seq) m.arrive(seg, lv);
  assert.deepEqual(m.history().map((e) => e.action), ['first', 'skip', 'skip', 'replace', 'first', 'replace', 'skip', 'replace']);
});

test('recordHistory 없으면 빈 배열, history() 는 사본', () => {
  const off = createLevelMachine();
  off.arrive(0, 1);
  assert.deepEqual(off.history(), []);
  const on = createLevelMachine({ recordHistory: true });
  on.arrive(0, 1);
  on.history()[0].level = 3;
  on.history().length = 0;
  assert.deepEqual(on.history(), [{ seq: 0, segmentId: 0, level: 1, action: 'first' }]);
});

test('formatHistory 정확 문자열', () => {
  const m = createLevelMachine({ recordHistory: true });
  m.arrive(4, 1); m.arrive(4, 0); m.arrive(4, 3);
  assert.deepEqual(formatHistory(m.history()), ['0 4 1 first', '1 4 0 skip', '2 4 3 replace']);
});

test('replayHistory 는 seq 어긋남을 거부', () => {
  assert.throws(() => replayHistory([{ seq: 1, segmentId: 0, level: 0, action: 'first' }]), RangeError);
});
