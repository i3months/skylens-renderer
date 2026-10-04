// 클라이언트·서버 수준 기계 동등성 시험. 시험에서만 server/ 를 import 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLevelMachine as createClient } from './index.mjs';
import { createLevelMachine as createServer } from '../../server/levels/state/index.mjs';

// 고정 시드 PRNG(mulberry32)
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('1만 개 무작위 입력 열에서 서버·클라이언트 기계가 모든 단계에서 같다', () => {
  const rand = prng(20240607);
  const int = (n) => Math.floor(rand() * n);
  const s = createServer({ recordHistory: true });
  const c = createClient({ recordHistory: true });
  const counts = { first: 0, replace: 0, skip: 0 };
  for (let i = 0; i < 10000; i++) {
    const kind = int(10);
    const seg = int(8);
    if (kind < 6) {
      const level = int(4);
      const pieces = rand() < 0.1 ? undefined : Array.from({ length: int(3) }, () => ({ count: int(500) }));
      const a = s.arrive(seg, level, pieces);
      const b = c.arrive(seg, level, pieces);
      assert.deepEqual(b, a, `arrive 불일치 #${i}`);
      counts[a.action]++;
    } else if (kind < 8) {
      s.expect(seg);
      c.expect(seg);
    } else {
      assert.deepEqual(c.snapshot(seg), s.snapshot(seg), `snapshot 불일치 #${i}`);
    }
    assert.deepEqual(c.snapshot(seg), s.snapshot(seg), `단계 snapshot 불일치 #${i}`);
    assert.deepEqual(c.segments(), s.segments(), `segments 불일치 #${i}`);
    assert.equal(c.pointCount(seg), s.pointCount(seg), `pointCount 불일치 #${i}`);
    assert.deepEqual(c.history(), s.history(), `history 불일치 #${i}`);
  }
  for (let seg = 0; seg < 8; seg++) assert.deepEqual(c.snapshot(seg), s.snapshot(seg));
  // 세 동작이 모두 충분히 나왔는지 확인(시험이 한쪽으로 치우치지 않았음)
  assert.ok(counts.first > 0 && counts.replace > 0 && counts.skip > 0, JSON.stringify(counts));
});

test('기준 숫자: 수준 0,1,2,3 순서 도착 4건의 action 열은 first,replace,replace,replace', () => {
  const m = createClient();
  const actions = [0, 1, 2, 3].map((lv) => m.arrive(0, lv, [{ count: 10 * (lv + 1) }]).action);
  assert.deepEqual(actions, ['first', 'replace', 'replace', 'replace']);
  assert.equal(m.pointCount(0), 40);
  assert.equal(m.snapshot(0).final, true);
});

test('기준 숫자: 역순 3,2,1,0 도착은 first,skip,skip,skip 이고 수준 3 조각만 남는다', () => {
  const m = createClient({ recordHistory: true });
  const actions = [3, 2, 1, 0].map((lv) => m.arrive(5, lv, [{ count: 7 + lv }]).action);
  assert.deepEqual(actions, ['first', 'skip', 'skip', 'skip']);
  assert.equal(m.pointCount(5), 10);
  assert.equal(m.history().length, 4);
});

test('기준 숫자: 같은 수준 재도착은 skip, 도착 안 한 구간은 없음·점 0', () => {
  const m = createClient();
  m.arrive(1, 2, [{ count: 5 }]);
  assert.equal(m.arrive(1, 2, [{ count: 99 }]).action, 'skip');
  assert.equal(m.pointCount(1), 5);
  m.expect(4);
  assert.deepEqual(m.snapshot(4), { segmentId: 4, level: -1, missing: true, final: false, pieces: [] });
  assert.equal(m.pointCount(4), 0);
  assert.deepEqual(m.segments(), [1, 4]);
  assert.deepEqual(m.history(), []);
});

test('입력 검사: 서버와 같은 오류 종류를 던진다', () => {
  const m = createClient();
  assert.throws(() => m.arrive(-1, 0), RangeError);
  assert.throws(() => m.arrive(1.5, 0), TypeError);
  assert.throws(() => m.arrive(0, 4), RangeError);
  assert.throws(() => m.arrive(0, 0, {}), TypeError);
});
