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

test('1000개 도착의 이력이 입력 열과 순서·구간·수준 일치, seq 0..n-1', () => {
  const r = rng(0x10c0de);
  const m = createLevelMachine({ recordHistory: true });
  const input = [];
  for (let i = 0; i < 1000; i++) {
    const segmentId = Math.floor(r() * 6);
    const level = Math.floor(r() * 4);
    input.push({ segmentId, level });
    m.arrive(segmentId, level);
  }
  const h = m.history();
  assert.equal(h.length, 1000);
  h.forEach((e, i) => assert.equal(e.seq, i));
  assert.deepEqual(replayHistory(h), input);
  assert.ok(h.some((e) => e.action === 'skip'));
  assert.ok(h.some((e) => e.action === 'replace'));
  assert.ok(h.some((e) => e.action === 'first'));
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
