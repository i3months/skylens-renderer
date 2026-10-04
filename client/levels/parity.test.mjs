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

// 열마다 새 기계 한 쌍(property 방식). 기계 하나에 긴 열을 먹이면 구간당 최대 3 번(수준 0→3)만
// replace 가 가능해 초반 이후는 skip 뿐이라 교체 경로를 거의 시험하지 못한다(F-180 ①).
//   열 2500개 × 구간 2개 × 도착 6건(구간당 평균 3건), 도착 사이에 expect·snapshot 4건을 섞는다.
// 하한의 근거: 수준을 0..3 균등 독립으로 뽑을 때 구간당 도착 k 건의 기대 replace 는 정확 열거(상태 = 현재 최고 수준)로
//   k=3 일 때 0.59375 이다. 열당 구간 2개 → 열당 1.1875, 2500열 → 기대 2968.75. 하한 2000 은 그 약 2/3 이다.
//   first 는 구간이 한 번이라도 도착하면 1 번(열당 ≈1.97 → 약 4922), skip = 15000 - first - replace ≈ 7100.
const COLUMNS = 2500;
const SEGS_PER_COLUMN = 2;
const ARRIVALS_PER_COLUMN = 6;

test('2500개 열(열마다 새 기계, 도착 1만 5천 건)에서 서버·클라이언트 기계가 모든 단계에서 같고 replace 가 수천 건이다', () => {
  const rand = prng(20240607);
  const int = (n) => Math.floor(rand() * n);
  const counts = { first: 0, replace: 0, skip: 0 };
  let arrivals = 0;
  for (let col = 0; col < COLUMNS; col++) {
    const s = createServer({ recordHistory: true });
    const c = createClient({ recordHistory: true });
    // 도착 6건과 기타 4건(expect 2·snapshot 2)의 순서를 섞는다.
    const steps = ['a', 'a', 'a', 'a', 'a', 'a', 'e', 'e', 'p', 'p'];
    for (let i = steps.length - 1; i > 0; i--) { const j = int(i + 1); [steps[i], steps[j]] = [steps[j], steps[i]]; }
    steps.forEach((kind, i) => {
      const seg = int(SEGS_PER_COLUMN);
      const where = `열 ${col} 단계 ${i}`;
      if (kind === 'a') {
        const level = int(4);
        const pieces = rand() < 0.1 ? undefined : Array.from({ length: int(3) }, () => ({ count: int(500) }));
        const a = s.arrive(seg, level, pieces);
        const b = c.arrive(seg, level, pieces);
        assert.deepEqual(b, a, `arrive 불일치 ${where}`);
        counts[a.action]++;
        arrivals++;
      } else if (kind === 'e') {
        s.expect(seg);
        c.expect(seg);
      } else {
        assert.deepEqual(c.snapshot(seg), s.snapshot(seg), `snapshot 불일치 ${where}`);
      }
      for (let id = 0; id < SEGS_PER_COLUMN; id++) {
        assert.deepEqual(c.snapshot(id), s.snapshot(id), `단계 snapshot 불일치 ${where}`);
        assert.equal(c.pointCount(id), s.pointCount(id), `pointCount 불일치 ${where}`);
      }
      assert.deepEqual(c.segments(), s.segments(), `segments 불일치 ${where}`);
      assert.deepEqual(c.history(), s.history(), `history 불일치 ${where}`);
    });
  }
  assert.equal(arrivals, COLUMNS * ARRIVALS_PER_COLUMN);
  assert.equal(counts.first + counts.replace + counts.skip, 15000);
  assert.ok(counts.replace >= 2000, `replace ${JSON.stringify(counts)}`);
  assert.ok(counts.first >= 4000, `first ${JSON.stringify(counts)}`);
  assert.ok(counts.skip >= 4000, `skip ${JSON.stringify(counts)}`);
});

// 손으로 쓴 4×4 표(F-180 ⑦): 같은 구간에 현재 수준 → 도착 수준 순으로 두 번 도착시킨 두 번째의 action.
// 계약 decideArrival 을 거치지 않는 독립 기대값이다(행 = 현재 수준 0..3, 열 = 도착 수준 0..3).
const HAND_TABLE = [
  ['skip', 'replace', 'replace', 'replace'],
  ['skip', 'skip', 'replace', 'replace'],
  ['skip', 'skip', 'skip', 'replace'],
  ['skip', 'skip', 'skip', 'skip'],
];

test('손계산 4×4 표: 두 번째 도착의 action 이 서버·클라이언트 모두에서 표와 같다', () => {
  for (const make of [createClient, createServer]) {
    for (let cur = 0; cur < 4; cur++) {
      for (let arr = 0; arr < 4; arr++) {
        const m = make();
        assert.equal(m.arrive(0, cur).action, 'first');
        assert.equal(m.arrive(0, arr).action, HAND_TABLE[cur][arr], `현재 ${cur} 도착 ${arr}`);
        assert.equal(m.snapshot(0).level, HAND_TABLE[cur][arr] === 'replace' ? arr : cur);
      }
    }
  }
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
