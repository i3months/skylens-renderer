// LEVEL_ARRIVED 재시도 판정·보관 판정(F-241, F-242 ④⑥). 시계는 고정값, 기대값은 손으로 적은 숫자다.
// 시간 단언은 없다: 비용은 levelStats().work(재시도 판정이 본 기록 수) 걸음 수로 잰다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from './index.mjs';

const T0 = 1000;
const mk = (maxEntriesPerSession) => createSessionStore({ maxSessions: 1, ttlMs: 60_000, now: () => T0, randomId: () => 77, maxEntriesPerSession });
/** 구간 seg 수준 level 의 조각 c, 타일 (tx, −2). */
const key = (seg, level, c, tx = 1) => ({ segmentId: seg, level, lod: 0, chunkIndex: c, tileX: tx, tileY: -2 });
const la = (segmentId, level, firstPieceSeq, pieceCount) => ({ type: 'LEVEL_ARRIVED', segmentId, level, firstPieceSeq, pieceCount });
const P = (seq, k) => ({ type: 'PIECE', pieceSeq: seq, key: k });
const OVERLAP = /LEVEL_ARRIVED 창 \d+\.\.\d+ 이 앞선 기록의 창과 겹친다/;

function sent(st, sid, k, seq) { assert.equal(st.recordSent(sid, k, seq, 1), true, `recordSent ${seq}`); }
const laOnly = (plan) => plan.filter((m) => m.type === 'LEVEL_ARRIVED');

test('F-241 ① R1: 대체로 지워진 기록의 같은 값 재시도는 ack(1) 앞뒤 모두 true, levels·resendPlan 그대로', () => {
  const st = mk();
  const sid = st.open({ sessionId: 0 }).sessionId;
  const K0 = key(9, 0, 0), K1 = key(9, 0, 1);
  sent(st, sid, K0, 1);
  sent(st, sid, K1, 2);
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 2)), true);
  sent(st, sid, K0, 3); // K0 대체: seq 1 이 죽어 창 1..2 기록이 지워진다(묘비)
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 3, 1)), true);
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 2)), true, 'ack 전 재시도');
  st.ack(sid, 1);
  const before = { stats: st.stats(sid), plan: st.resendPlan(sid) };
  assert.deepEqual(before.stats, { entries: 2, retainedBytes: 2, unacked: 2, groups: 1, levels: 1 });
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 2)), true, 'ack(1) 뒤 재시도(고치기 전: RangeError)');
  assert.deepEqual(st.stats(sid), before.stats);
  assert.deepEqual(st.resendPlan(sid), before.plan);
  st.open({ sessionId: sid, lastPieceSeq: 1 });
  assert.deepEqual(st.resendPlan(sid), [P(2, K1), P(3, K0), la(9, 0, 3, 1)]);
});

test('F-241 ② R2: LEVEL_ARRIVED 를 추월 조각 앞에 기록하든 뒤에 기록하든 resendPlan 이 같다', () => {
  const k00 = key(9, 0, 0, 0), k01 = key(9, 0, 0, 1), k10 = key(9, 1, 0, 0); // k10 이 타일 0 묶음의 k00 을 추월
  const run = (laFirst) => {
    const st = mk();
    const sid = st.open({ sessionId: 0 }).sessionId;
    sent(st, sid, k00, 1);
    sent(st, sid, k01, 2);
    if (laFirst) assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 2)), true);
    sent(st, sid, k10, 3);
    if (!laFirst) assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 2)), true); // 늦은 첫 기록: seq 1 은 이미 추월당함
    assert.equal(st.levelStats(sid).stored, 1, '추월은 보관 판정에 들지 않는다');
    assert.equal(st.stats(sid).levels, 0, '내보내기 판정(windowLive)은 추월을 뺀다');
    assert.equal(st.recordLevelArrived(sid, la(9, 1, 3, 1)), true);
    st.ack(sid, 1);
    assert.equal(st.open({ sessionId: sid, lastPieceSeq: 2 }).resumed, true);
    return st.resendPlan(sid);
  };
  const expected = [la(9, 0, 1, 2), P(3, k10), la(9, 1, 3, 1)];
  assert.deepEqual(run(true), expected);
  assert.deepEqual(run(false), expected, '고치기 전: [la(9,1,3,1)] 만');
});

test('F-241 ③: ack 로 지워진 앞 기록과 겹치는 다른 값(창 끝 == ackedUpTo)은 RangeError, 아무것도 남기지 않는다', () => {
  const st = mk();
  const sid = st.open({ sessionId: 0 }).sessionId;
  sent(st, sid, key(9, 0, 0), 1);
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 1)), true);
  sent(st, sid, key(9, 1, 0), 2);
  st.ack(sid, 2);
  assert.throws(() => st.recordLevelArrived(sid, la(9, 1, 1, 2)), OVERLAP, '고치기 전: true, levels 0');
  assert.equal(st.levelStats(sid).stored, 0);
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 1)), true, '같은 값 재시도는 true');
  assert.deepEqual(st.resendPlan(sid), []);
});

test('F-241 ⑤: 아직 기록하지 않은 순번의 창은 겹치지 않아도 "조각 먼저 기록" RangeError', () => {
  const st = mk();
  const sid = st.open({ sessionId: 0 }).sessionId;
  sent(st, sid, key(9, 0, 0), 1);
  sent(st, sid, key(9, 0, 1), 2);
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 2)), true);
  // 창 3..3 은 앞 창 1..2 와 겹치지 않는다 — 앞 기록의 겹침 검사가 대신 던질 수 없는 자리.
  assert.throws(() => st.recordLevelArrived(sid, la(10, 0, 3, 1)), /이하여야 한다\(조각 먼저 기록\)/);
  sent(st, sid, key(10, 0, 0), 3);
  assert.equal(st.recordLevelArrived(sid, la(10, 0, 3, 1)), true);
  st.open({ sessionId: sid, lastPieceSeq: 2 });
  assert.deepEqual(st.resendPlan(sid), [la(9, 0, 1, 2), P(3, key(10, 0, 0)), la(10, 0, 3, 1)]);
});

test('F-242 ④: segmentId 는 SEGMENT_ID_LIMIT(2^30) 미만 — 저장소가 거부한다', () => {
  const st = mk();
  const sid = st.open({ sessionId: 0 }).sessionId;
  const top = 2 ** 30 - 1;
  sent(st, sid, key(top, 0, 0), 1);
  assert.equal(st.recordLevelArrived(sid, la(top, 0, 1, 1)), true);
  assert.throws(() => st.recordSent(sid, key(2 ** 30, 0, 0), 2, 1), /key\.segmentId 는 0 이상 1073741824 미만/);
  assert.throws(() => st.shouldSend(sid, key(2 ** 30, 0, 0)), /key\.segmentId/);
  sent(st, sid, key(1, 0, 0), 2);
  assert.throws(() => st.recordLevelArrived(sid, la(2 ** 30, 0, 2, 1)), /segmentId 는 0 이상 1073741824 미만/);
  assert.throws(() => st.recordLevelArrived(sid, la(0xffffffff, 0, 2, 1)), RangeError);
  assert.equal(st.levelStats(sid).stored, 1, '거부된 기록은 남지 않는다');
});

test('F-242 ⑥·F-241 지평: levelStats 의 미저장·대조 없는 수락·상한 삭제 누계, 묘비 상한 maxEntries + 1', () => {
  const st = mk(1); // 묘비 상한 2
  const sid = st.open({ sessionId: 0 }).sessionId;
  assert.equal(st.levelStats(12345), null, '모르는 세션');
  // 창 n..n 하나씩, 매번 ack(n) — 앞 기록은 ack 로 지워져 묘비가 된다.
  for (let n = 1; n <= 4; n++) {
    sent(st, sid, key(n, 0, 0), n);
    assert.equal(st.recordLevelArrived(sid, la(n, 0, n, 1)), true);
    st.ack(sid, n);
  }
  // 묘비 1..1·2..2·3..3 중 가장 먼저 된 1..1 을 잊었다: 지평 1.
  assert.deepEqual(st.levelStats(sid), { stored: 1, tombstones: 2, horizon: 1, unstored: 0, blind: 0, capDropped: 0, work: 0 });
  assert.equal(st.recordLevelArrived(sid, la(1, 0, 1, 1)), true, '(b) 잊은 묘비의 같은 값');
  assert.equal(st.recordLevelArrived(sid, la(7, 0, 1, 1)), true, '(b) 대가: 잊은 범위의 다른 값도 대조 없이 true');
  assert.throws(() => st.recordLevelArrived(sid, la(7, 0, 2, 1)), OVERLAP, '(c) 기억한 묘비 2..2 와 다른 값');
  assert.equal(st.recordLevelArrived(sid, la(2, 0, 2, 1)), true, '(a) 묘비 2..2');
  assert.equal(st.recordLevelArrived(sid, la(4, 0, 4, 1)), true, '(a) 보관 중 4..4');
  // 보관하지 않은 새 기록: 창 5..5 의 조각이 대체로 죽었다.
  sent(st, sid, key(5, 0, 0), 5);
  sent(st, sid, key(5, 0, 0), 6);
  assert.equal(st.recordLevelArrived(sid, la(5, 0, 5, 1)), true);
  // 5..5 가 묘비가 되며 묘비 2..2 를 잊는다(남은 묘비 3..3·5..5): 지평 2.
  assert.deepEqual(st.levelStats(sid), { stored: 1, tombstones: 2, horizon: 2, unstored: 1, blind: 2, capDropped: 0, work: 5 });
  assert.deepEqual(laOnly(st.resendPlan(sid)), [la(4, 0, 4, 1)]);
});

test('F-241 ④: 지워진 기록 재시도 판정은 호출당 1 걸음 — 기록 수 L 에 무관', () => {
  const perCall = (L) => {
    const st = mk(4 * L);
    const sid = st.open({ sessionId: 0 }).sessionId;
    for (let i = 1; i <= L; i++) {
      sent(st, sid, key(i, 0, 0), i);
      assert.equal(st.recordLevelArrived(sid, la(i, 0, i, 1)), true);
    }
    // 45% 를 같은 key 새 순번으로 대체: 그 창의 기록이 지워진다(묘비).
    const replaced = [];
    let seq = L;
    for (let i = 1; i <= L; i++) if (i % 20 < 9) { sent(st, sid, key(i, 0, 0), ++seq); replaced.push(i); }
    assert.equal(replaced.length, (L / 20) * 9);
    assert.equal(st.levelStats(sid).stored, L - replaced.length);
    assert.equal(st.levelStats(sid).tombstones, replaced.length, '대체로 지운 기록은 묘비로 센다(묘비 상한의 대상)');
    const w0 = st.levelStats(sid).work;
    for (const i of replaced) assert.equal(st.recordLevelArrived(sid, la(i, 0, i, 1)), true);
    const ls = st.levelStats(sid);
    assert.equal(ls.blind, 0);
    return (ls.work - w0) / replaced.length;
  };
  assert.equal(perCall(8000), 1);
  assert.equal(perCall(80_000), 1);
});

/** 결정적 의사난수(mulberry32). */
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

test('F-241 무작위: 같은 값 재시도 예외 0, 다른 값은 지평 밖이면 RangeError, 보관 기록 ≤ unacked + 1', () => {
  let retries = 0, blindSeen = 0, rejects = 0;
  for (const seed of [1, 2, 3, 4]) {
    for (const MAX of [3, 8]) {
      const rand = rng(seed * 100 + MAX);
      const st = mk(MAX);
      const sid = st.open({ sessionId: 0 }).sessionId;
      let seq = 0;          // 기록한 최대 순번
      let winStart = 1;     // 아직 LEVEL_ARRIVED 로 묶지 않은 첫 순번
      const accepted = [];  // 받은 새 기록
      for (let step = 0; step < 3000; step++) {
        const r = rand();
        if (r < 0.4) {
          // 작은 key 집합(같은 key 대체·같은 묶음 추월이 자주 일어난다).
          const k = key(1 + Math.floor(rand() * 3), Math.floor(rand() * 4), Math.floor(rand() * 2), Math.floor(rand() * 2));
          if (st.recordSent(sid, k, seq + 1, 1)) seq++;
          else st.ack(sid, seq); // 항목 상한: 확인해 자리를 만든다
        } else if (r < 0.6) {
          if (seq >= winStart) {
            const rec = la(1 + Math.floor(rand() * 3), Math.floor(rand() * 4), winStart, seq - winStart + 1);
            assert.equal(st.recordLevelArrived(sid, rec), true);
            accepted.push(rec);
            winStart = seq + 1;
          }
        } else if (r < 0.7) {
          st.ack(sid, Math.floor(rand() * (seq + 1)));
        } else if (r < 0.75) {
          st.open({ sessionId: sid, lastPieceSeq: Math.floor(rand() * (seq + 1)) });
        } else if (r < 0.95) {
          if (accepted.length > 0) {
            const rec = accepted[Math.floor(rand() * accepted.length)];
            retries++;
            assert.equal(st.recordLevelArrived(sid, rec), true, `seed ${seed} MAX ${MAX} step ${step} 같은 값 재시도`);
          }
        } else if (accepted.length > 0) {
          const rec = accepted[Math.floor(rand() * accepted.length)];
          const other = { ...rec, segmentId: rec.segmentId + 10 };
          const last = rec.firstPieceSeq + rec.pieceCount - 1;
          if (last > st.levelStats(sid).horizon) { assert.throws(() => st.recordLevelArrived(sid, other), OVERLAP); rejects++; }
          else { assert.equal(st.recordLevelArrived(sid, other), true); blindSeen++; }
        }
        const s = st.stats(sid);
        const ls = st.levelStats(sid);
        assert.ok(ls.stored <= s.unacked + 1, `seed ${seed} MAX ${MAX} step ${step}: stored ${ls.stored} > unacked ${s.unacked} + 1`);
        assert.ok(ls.tombstones <= MAX + 1);
        assert.equal(ls.capDropped, 0);
        if (step % 50 === 0) assert.equal(s.levels, laOnly(st.resendPlan(sid)).length);
      }
    }
  }
  // 무작위 입력이 세 갈래를 모두 지났는지(시험이 헛돌지 않는지).
  assert.ok(retries > 1000, `retries ${retries}`);
  assert.ok(blindSeen > 0, `blind ${blindSeen}`);
  assert.ok(rejects > 0, `rejects ${rejects}`);
});
