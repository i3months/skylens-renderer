// LEVEL_ARRIVED 기록·재전송(F-236). 시계는 고정값을 주입하고 시간 단언은 없다.
// 기대값은 손으로 적은 순번·key 문자열이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from './index.mjs';
import { encodeMessage } from '../../proto/codec/index.mjs';
import { decodeMessage } from '../../../client/proto/index.mjs';
import { collectArrivals } from '../../../contracts/client_raster/arrival.mjs';
import { selectDrawable, ClientRasterError } from '../../../contracts/client_raster/index.mjs';

const T0 = 1000;
const store = () => createSessionStore({ maxSessions: 4, ttlMs: 60_000, now: () => T0, randomId: () => 77 });

/** 구간 seg 수준 level 의 조각 c 의 key: (lod 0, chunkIndex c, tile (tx, −2)). §11 문자열은 'seg.level.tx.-2.0.c'. */
const key = (seg, level, c, tx = 1) => ({ segmentId: seg, level, lod: 0, chunkIndex: c, tileX: tx, tileY: -2 });
const chunkOf = (seq) => Uint8Array.of(seq, 0x5a);
const piece = (seq, k) => ({ type: 'PIECE', pieceSeq: seq, key: k, chunk: chunkOf(seq) });
const la = (segmentId, level, firstPieceSeq, pieceCount) => ({ type: 'LEVEL_ARRIVED', segmentId, level, firstPieceSeq, pieceCount });

/**
 * 서버 쪽 송출: 어댑터 순서(조각들 → LEVEL_ARRIVED)대로 저장소에 기록하고 선 프레임(서버 코덱)을 돌려준다.
 * 어댑터의 emit 이 하는 일과 같은 순서다(recordSent → recordLevelArrived).
 */
function send(st, sid, messages) {
  const frames = [];
  for (const m of messages) {
    if (m.type === 'PIECE') assert.equal(st.recordSent(sid, m.key, m.pieceSeq, m.chunk), true);
    else assert.equal(st.recordLevelArrived(sid, m), true);
    frames.push(encodeMessage(m));
  }
  return frames;
}
/** 다시 보낼 계획을 선 프레임으로(조각 bytes 는 호출자가 붙인다). */
const resendFrames = (plan) => plan.map((m) => encodeMessage(m.type === 'PIECE' ? { ...m, chunk: chunkOf(m.pieceSeq) } : m));
const isPieceErr = (e) => e instanceof ClientRasterError && e.code === 'piece';

// 공통 송출: 구간 9 수준 0 (조각 seq 1·2) → LEVEL_ARRIVED(first 1, n 2), 구간 9 수준 1 (조각 seq 3·4·5) → LEVEL_ARRIVED(first 3, n 3).
const LEVEL0 = [piece(1, key(9, 0, 0)), piece(2, key(9, 0, 1)), la(9, 0, 1, 2)];
const LEVEL1 = [piece(3, key(9, 1, 0)), piece(4, key(9, 1, 1)), piece(5, key(9, 1, 2)), la(9, 1, 3, 3)];
const L0_KEYS = ['9.0.1.-2.0.0', '9.0.1.-2.0.1'];
const L1_KEYS = ['9.1.1.-2.0.0', '9.1.1.-2.0.1', '9.1.1.-2.0.2'];

test('F-236 확인 기준: PIECE 전부 수신, LEVEL_ARRIVED 유실, HELLO(lastPieceSeq=f+n−1) → 재개 뒤 n 개 key 를 그린다', () => {
  const st = store();
  const w = st.open({ sessionId: 0, lastPieceSeq: 0 });
  assert.deepEqual(w, { sessionId: 77, resumed: false, nextPieceSeq: 1, reason: null });
  const sid = w.sessionId;
  const frames = send(st, sid, [...LEVEL0, ...LEVEL1]);
  // 끊김: 마지막 프레임(LEVEL_ARRIVED(9,1,3,3))만 잃었다. 조각 f..f+n−1 = 3..5 는 모두 받았다.
  const client = [{ type: 'WELCOME', sessionId: 77, resumed: false, nextPieceSeq: 1 }, ...frames.slice(0, -1).map(decodeMessage)];

  // 고치기 전 상태: 수준 1 은 완료 표시가 없어 pending 이다(그려지지 않음).
  const before = collectArrivals(client);
  assert.deepEqual(before.arrived, [{ segmentId: 9, level: 0, keys: L0_KEYS }]);
  assert.deepEqual(selectDrawable(before.keys, before.arrived), { draw: L0_KEYS, pending: L1_KEYS, discard: [] });

  // HELLO(lastPieceSeq = 5) 이어받기. 조각은 모두 확인됐고, 잃은 LEVEL_ARRIVED 하나만 다시 나간다.
  assert.deepEqual(st.open({ sessionId: sid, lastPieceSeq: 5 }), { sessionId: 77, resumed: true, nextPieceSeq: 6, reason: null });
  assert.deepEqual(st.unacked(sid), []);
  const plan = st.resendPlan(sid);
  assert.deepEqual(plan, [la(9, 1, 3, 3)]);

  client.push({ type: 'WELCOME', sessionId: 77, resumed: true, nextPieceSeq: 6 }, ...resendFrames(plan).map(decodeMessage));
  const after = collectArrivals(client);
  assert.deepEqual(after.arrived, [{ segmentId: 9, level: 0, keys: L0_KEYS }, { segmentId: 9, level: 1, keys: L1_KEYS }]);
  assert.deepEqual(selectDrawable(after.keys, after.arrived), { draw: L1_KEYS, pending: [], discard: L0_KEYS });
});

test('F-236: 혼자 다시 온 LEVEL_ARRIVED 는 멱등 — 이미 받았어도, 더 큰 pieceSeq 뒤에 와도 같은 완료 집합', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  // 클라이언트가 LEVEL_ARRIVED(9,1) 까지 다 받았지만 HELLO lastPieceSeq 는 5(창 끝)라 서버는 그것을 모른다.
  const frames = send(st, sid, [...LEVEL0, ...LEVEL1]);
  const client = frames.map(decodeMessage);
  const once = collectArrivals(client);
  const drawOnce = selectDrawable(once.keys, once.arrived);
  assert.deepEqual(drawOnce, { draw: L1_KEYS, pending: [], discard: L0_KEYS });

  st.open({ sessionId: sid, lastPieceSeq: 5 });
  const plan = st.resendPlan(sid);
  assert.deepEqual(plan, [la(9, 1, 3, 3)]);
  // 재개 뒤 다른 구간의 더 큰 pieceSeq 가 먼저 와 있어도(창을 maxSeq 로 추정했다면 6 을 끝으로 보아 거부됐을 자리) 같은 집합이다.
  client.push(...resendFrames(plan).map(decodeMessage));
  client.push(...send(st, sid, [piece(6, key(10, 0, 0)), la(10, 0, 6, 1)]).map(decodeMessage));
  client.push(...resendFrames(plan).map(decodeMessage)); // 같은 것을 한 번 더
  const twice = collectArrivals(client);
  assert.deepEqual(twice.arrived, [
    { segmentId: 9, level: 0, keys: L0_KEYS },
    { segmentId: 9, level: 1, keys: L1_KEYS },
    { segmentId: 9, level: 1, keys: L1_KEYS },
    { segmentId: 10, level: 0, keys: ['10.0.1.-2.0.0'] },
    { segmentId: 9, level: 1, keys: L1_KEYS },
  ]);
  assert.deepEqual(selectDrawable(twice.keys, twice.arrived), { draw: [...L1_KEYS, '10.0.1.-2.0.0'], pending: [], discard: L0_KEYS });
  // 대조: firstPieceSeq 가 없는(옛 9 B) 같은 완료 표시를 그 자리에 두면 창을 maxSeq 6 으로 추정해 거부된다.
  const legacy = client.slice(0, -1).concat({ type: 'LEVEL_ARRIVED', segmentId: 9, level: 1, pieceCount: 3 });
  assert.throws(() => collectArrivals(legacy), isPieceErr);
});

test('resendPlan: 미확인 조각 순번 순, LEVEL_ARRIVED 는 자기 창 끝 조각 뒤·더 큰 순번 앞, 확인된 창은 빠진다', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, [...LEVEL0, ...LEVEL1, piece(6, key(10, 0, 0)), la(10, 0, 6, 1)]);
  st.open({ sessionId: sid, lastPieceSeq: 4 });
  assert.deepEqual(st.resendPlan(sid), [
    { type: 'PIECE', pieceSeq: 5, key: key(9, 1, 2) },
    la(9, 1, 3, 3),
    { type: 'PIECE', pieceSeq: 6, key: key(10, 0, 0) },
    la(10, 0, 6, 1),
  ]);
  // PIECE 부분은 unacked 와 같다.
  assert.deepEqual(st.resendPlan(sid).filter((m) => m.type === 'PIECE').map((m) => [m.pieceSeq, m.key]), st.unacked(sid).map((u) => [u.seq, u.key]));
  // 받는 쪽: seq 1..4 와 LEVEL_ARRIVED(9,0) 를 받은 뒤 계획대로 다시 받으면 두 수준 모두 완료.
  const client = [...LEVEL0, piece(3, key(9, 1, 0)), piece(4, key(9, 1, 1))].map((m) => decodeMessage(encodeMessage(m)));
  client.push(...resendFrames(st.resendPlan(sid)).map(decodeMessage));
  const r = collectArrivals(client);
  assert.deepEqual(selectDrawable(r.keys, r.arrived), { draw: [...L1_KEYS, '10.0.1.-2.0.0'], pending: [], discard: L0_KEYS });
});

test('recordLevelArrived 확인 규칙: ackedUpTo == 창 끝이면 남기고, 창 끝보다 크면 지운다', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, [...LEVEL0, ...LEVEL1]);
  st.ack(sid, 2);
  assert.deepEqual(st.resendPlan(sid).filter((m) => m.type === 'LEVEL_ARRIVED'), [la(9, 0, 1, 2), la(9, 1, 3, 3)]);
  st.ack(sid, 3);
  assert.deepEqual(st.resendPlan(sid).filter((m) => m.type === 'LEVEL_ARRIVED'), [la(9, 1, 3, 3)]);
  st.ack(sid, 5);
  assert.deepEqual(st.resendPlan(sid), [la(9, 1, 3, 3)]);
  // 확인돼 지운 기록의 재기록(어댑터 재시도)도 멱등 true 이고 되살아나지 않는다.
  send(st, sid, [piece(6, key(10, 0, 0))]);
  st.ack(sid, 6);
  assert.deepEqual(st.resendPlan(sid), []);
  assert.equal(st.recordLevelArrived(sid, la(9, 1, 3, 3)), true);
  assert.deepEqual(st.resendPlan(sid), []);
});

test('resendPlan: 창 안 미확인 조각이 추월로 빠지면 그 LEVEL_ARRIVED 는 보내지 않는다', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  // 수준 1: 타일 1 (seq 3), 타일 2 (seq 4). 그다음 수준 2 타일 1 (seq 5) 가 타일 1 묶음을 추월한다.
  send(st, sid, [...LEVEL0, piece(3, key(9, 1, 0, 1)), piece(4, key(9, 1, 0, 2)), la(9, 1, 3, 2), piece(5, key(9, 2, 0, 1)), la(9, 2, 5, 1)]);
  st.open({ sessionId: sid, lastPieceSeq: 2 });
  assert.deepEqual(st.resendPlan(sid), [
    la(9, 0, 1, 2), // 창 끝 2 == lastPieceSeq: 조각은 다 받았고 완료 표시는 모르는 상태라 다시 보낸다(멱등)
    { type: 'PIECE', pieceSeq: 4, key: key(9, 1, 0, 2) },
    { type: 'PIECE', pieceSeq: 5, key: key(9, 2, 0, 1) },
    la(9, 2, 5, 1),
  ]);
});

test('recordLevelArrived 입력 검사', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, LEVEL0);
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 2)), true, '같은 기록 재기록은 멱등');
  assert.throws(() => st.recordLevelArrived(sid, la(9, 0, 2, 2)), /조각 먼저 기록/, '창 끝 3 > 기록한 최대 순번 2');
  assert.throws(() => st.recordLevelArrived(sid, la(9, 1, 2, 1)), RangeError, '창 끝 역행(같은 끝, 다른 기록)');
  assert.throws(() => st.recordLevelArrived(sid, la(9, 0, 0, 1)), RangeError);
  assert.throws(() => st.recordLevelArrived(sid, la(9, 0, 1, 0)), RangeError);
  assert.throws(() => st.recordLevelArrived(sid, la(9, 4, 1, 1)), RangeError);
  assert.throws(() => st.recordLevelArrived(sid, la(9, 0, 0xffffffff, 2)), RangeError);
  assert.throws(() => st.recordLevelArrived(sid, null), TypeError);
  assert.equal(st.recordLevelArrived(12345, la(9, 0, 1, 1)), false, '모르는 세션');
  assert.deepEqual(st.resendPlan(12345), []);
  assert.deepEqual(st.resendPlan(sid), [
    { type: 'PIECE', pieceSeq: 1, key: key(9, 0, 0) }, { type: 'PIECE', pieceSeq: 2, key: key(9, 0, 1) }, la(9, 0, 1, 2),
  ]);
});

// 구간 10 수준 0 (조각 seq 3·4·5) → LEVEL_ARRIVED(first 3, n 3). 구간 9 와 묶음이 달라 추월하지 않는다(F-238 시험용).
const SEG10 = [piece(3, key(10, 0, 0)), piece(4, key(10, 0, 1)), piece(5, key(10, 0, 2)), la(10, 0, 3, 3)];
const SEG10_KEYS = ['10.0.1.-2.0.0', '10.0.1.-2.0.1', '10.0.1.-2.0.2'];

/** 이어받기 재전송: resendPlan 의 메시지를 어댑터처럼 다시 내보내며 기록한다(PIECE 는 recordSent, LEVEL_ARRIVED 는 recordLevelArrived). */
function rerecord(st, sid, plan) {
  for (const m of plan) {
    if (m.type === 'PIECE') assert.equal(st.recordSent(sid, m.key, m.pieceSeq, chunkOf(m.pieceSeq)), true, `PIECE ${m.pieceSeq}`);
    else assert.equal(st.recordLevelArrived(sid, m), true, `LEVEL_ARRIVED ${m.segmentId}.${m.level}`);
  }
}

test('F-238 ① 감독 재현: LEVEL_ARRIVED 2개 → open(lastPieceSeq=0) → resendPlan 재기록이 모두 멱등 true', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, [...LEVEL0, ...SEG10]); // 서로 다른 묶음이라 추월 없음
  assert.equal(st.open({ sessionId: sid, lastPieceSeq: 0 }).resumed, true);
  const plan = st.resendPlan(sid);
  assert.deepEqual(plan, [
    { type: 'PIECE', pieceSeq: 1, key: key(9, 0, 0) }, { type: 'PIECE', pieceSeq: 2, key: key(9, 0, 1) }, la(9, 0, 1, 2),
    { type: 'PIECE', pieceSeq: 3, key: key(10, 0, 0) }, { type: 'PIECE', pieceSeq: 4, key: key(10, 0, 1) }, { type: 'PIECE', pieceSeq: 5, key: key(10, 0, 2) },
    la(10, 0, 3, 3),
  ]);
  rerecord(st, sid, plan); // 고치기 전: 첫 LEVEL_ARRIVED 에서 RangeError
  assert.equal(st.stats(sid).levels, 2);
  // 재기록은 아무것도 바꾸지 않는다: 같은 계획이 다시 나오고, 한 번 더 재기록해도 멱등.
  st.open({ sessionId: sid, lastPieceSeq: 0 });
  assert.deepEqual(st.resendPlan(sid), plan);
  rerecord(st, sid, st.resendPlan(sid));
  // 다시 내보낸 계획을 클라이언트가 받으면 두 수준 모두 완료.
  const client = [{ type: 'WELCOME', sessionId: 77, resumed: false, nextPieceSeq: 1 }, { type: 'WELCOME', sessionId: 77, resumed: true, nextPieceSeq: 6 }, ...resendFrames(plan).map(decodeMessage)];
  const r = collectArrivals(client);
  assert.deepEqual(selectDrawable(r.keys, r.arrived), { draw: [...L0_KEYS, ...SEG10_KEYS], pending: [], discard: [] });
  // 창 끝 == ackedUpTo 로 남은 기록(lastPieceSeq=2)도 재기록 멱등.
  st.open({ sessionId: sid, lastPieceSeq: 2 });
  const plan2 = st.resendPlan(sid);
  assert.deepEqual(plan2.filter((m) => m.type === 'LEVEL_ARRIVED'), [la(9, 0, 1, 2), la(10, 0, 3, 3)]);
  rerecord(st, sid, plan2);
  assert.deepEqual(st.resendPlan(sid), plan2);
});

test('F-238 ①③: 남은 기록과 네 값 중 하나라도 다르면 멱등이 아니라 겹치는 창 RangeError', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, [...LEVEL0, ...SEG10]);
  const OVERLAP = /LEVEL_ARRIVED 창 \d+\.\.\d+ 이 앞선 기록의 창과 겹친다: 창 시작은 앞선 기록의 창 끝\(5\)보다 커야 한다/;
  assert.throws(() => st.recordLevelArrived(sid, la(9, 0, 1, 1)), OVERLAP, 'pieceCount 다름');
  assert.throws(() => st.recordLevelArrived(sid, la(8, 0, 1, 2)), OVERLAP, 'segmentId 다름');
  assert.throws(() => st.recordLevelArrived(sid, la(9, 2, 1, 2)), OVERLAP, 'level 다름');
  assert.throws(() => st.recordLevelArrived(sid, la(9, 0, 2, 1)), OVERLAP, 'firstPieceSeq 다름');
  assert.equal(st.stats(sid).levels, 2);
});

test('F-238 ③: 앞 기록과 겹치는 창은 RangeError(창 끝이 더 커도), 바로 뒤에 붙는 창은 받는다', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, [piece(1, key(9, 0, 0)), piece(2, key(9, 0, 1)), la(9, 0, 1, 2), piece(3, key(10, 0, 0)), piece(4, key(10, 0, 1))]);
  const OVERLAP = /LEVEL_ARRIVED 창 (\d+)\.\.(\d+) 이 앞선 기록의 창과 겹친다: 창 시작은 앞선 기록의 창 끝\(2\)보다 커야 한다/;
  assert.throws(() => st.recordLevelArrived(sid, la(10, 0, 2, 2)), OVERLAP, '창 2..3 은 앞 창 1..2 와 겹친다');
  assert.throws(() => st.recordLevelArrived(sid, la(10, 0, 1, 4)), OVERLAP, '창 1..4 는 앞 창을 덮는다');
  assert.throws(() => st.recordLevelArrived(sid, la(10, 0, 2, 3)), OVERLAP, '창 2..4');
  assert.equal(st.stats(sid).levels, 1, '거부된 기록은 남지 않는다');
  assert.equal(st.recordLevelArrived(sid, la(10, 0, 3, 2)), true, '창 3..4 는 겹치지 않는다');
  st.open({ sessionId: sid, lastPieceSeq: 0 });
  assert.deepEqual(st.resendPlan(sid).filter((m) => m.type === 'LEVEL_ARRIVED'), [la(9, 0, 1, 2), la(10, 0, 3, 2)]);
});

test('F-238 ②: 같은 key 를 새 순번으로 1만 회 대체하며 기록해도 levels ≤ maxEntries + 1, 죽은 창의 기록은 정리된다', () => {
  const MAX = 64;
  const st = createSessionStore({ maxSessions: 1, ttlMs: 60_000, now: () => T0, randomId: () => 5, maxEntriesPerSession: MAX });
  const sid = st.open({ sessionId: 0 }).sessionId;
  const k = key(3, 1, 0);
  const N = 10_000;
  for (let seq = 1; seq <= N; seq++) {
    assert.equal(st.recordSent(sid, k, seq, 1), true);
    assert.equal(st.recordLevelArrived(sid, la(3, 1, seq, 1)), true);
  }
  const s = st.stats(sid);
  assert.ok(Object.hasOwn(s, 'levels'), 'stats().levels 노출');
  // 근거(머리 주석 불변식, 결정 0033): 보관 기록 수 ≤ 미확인 조각 수 + 1 ≤ MAX + 1. 여기서는 미확인 조각이 1 개(같은 key
  // 마지막 순번)이고 창 끝 == ackedUpTo 인 기록이 없으므로 정확히 1 이다(등호로 단언).
  assert.equal(st.levelStats(sid).stored, 1);
  assert.equal(s.levels, 1);
  assert.equal(st.levelStats(sid).capDropped, 0, '방어용 상한은 걸리지 않는다');
  // 앞의 창(seq 1..N−1)은 조각이 대체로 죽어 다시 보낼 수 없으므로 지워지고 마지막 하나만 남는다.
  assert.deepEqual(s, { entries: 1, retainedBytes: 1, unacked: 1, groups: 1, levels: 1 });
  st.open({ sessionId: sid, lastPieceSeq: 0 });
  assert.deepEqual(st.resendPlan(sid), [{ type: 'PIECE', pieceSeq: N, key: k }, la(3, 1, N, 1)]);
});

test('F-238 ②: 기록 때 창 안 미확인 순번이 이미 죽었거나 기록된 적 없으면 보관하지 않는다', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, [piece(1, key(9, 0, 0)), piece(2, key(9, 0, 0))]); // seq 1 은 seq 2 로 대체돼 죽었다
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 1)), true);
  assert.equal(st.stats(sid).levels, 0);
  send(st, sid, [piece(4, key(10, 0, 0))]); // seq 3 은 기록된 적 없다
  assert.equal(st.recordLevelArrived(sid, la(10, 0, 3, 2)), true);
  assert.equal(st.stats(sid).levels, 0);
  assert.equal(st.recordLevelArrived(sid, la(10, 0, 3, 2)), true, '마지막 기록 재기록은 멱등');
  st.open({ sessionId: sid, lastPieceSeq: 0 });
  assert.deepEqual(st.resendPlan(sid), [{ type: 'PIECE', pieceSeq: 2, key: key(9, 0, 0) }, { type: 'PIECE', pieceSeq: 4, key: key(10, 0, 0) }]);
});

test('levels 상한은 maxEntries + 1 — 창 끝 == ackedUpTo 인 기록을 지우지 않아 resendPlan 에 남는다', () => {
  const st = createSessionStore({ maxSessions: 1, ttlMs: 60_000, now: () => T0, randomId: () => 5, maxEntriesPerSession: 2 });
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, [piece(1, key(9, 0, 0)), la(9, 0, 1, 1)]);
  st.ack(sid, 1); // 창 1..1 은 창 끝 == ackedUpTo 라 남는다(완료 표시 수신 미상)
  send(st, sid, [piece(2, key(10, 0, 0)), la(10, 0, 2, 1)]);
  assert.equal(st.stats(sid).levels, 2);
  send(st, sid, [piece(3, key(11, 0, 0)), la(11, 0, 3, 1)]); // 조각 1 은 항목 상한으로 축출, 기록은 3개(= maxEntries + 1)
  assert.deepEqual(st.stats(sid), { entries: 2, retainedBytes: 4, unacked: 2, groups: 2, levels: 3 });
  assert.equal(st.open({ sessionId: sid, lastPieceSeq: 1 }).resumed, true);
  assert.deepEqual(st.resendPlan(sid), [
    la(9, 0, 1, 1),
    { type: 'PIECE', pieceSeq: 2, key: key(10, 0, 0) }, la(10, 0, 2, 1),
    { type: 'PIECE', pieceSeq: 3, key: key(11, 0, 0) }, la(11, 0, 3, 1),
  ]);
});

test('F-238 ① 멱등 (c): 같은 key 대체로 지워진 기록의 재시도는 true, 아무것도 저장하지 않는다', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, [piece(1, key(9, 0, 0)), la(9, 0, 1, 1)]);
  send(st, sid, [piece(2, key(9, 0, 0))]); // seq 1 이 seq 2 로 대체돼 LEVEL_ARRIVED(1..1) 기록이 지워진다
  assert.equal(st.stats(sid).levels, 0);
  send(st, sid, [la(9, 0, 2, 1)]);
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 1)), true, '지워진 기록의 재시도(고치기 전: RangeError)');
  assert.equal(st.stats(sid).levels, 1, '되살아나지 않는다');
  st.ack(sid, 1); // 경계: 창 끝 1 == ackedUpTo 이고 남은 기록과 겹치지 않는다
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 1)), true);
  st.open({ sessionId: sid, lastPieceSeq: 1 });
  assert.deepEqual(st.resendPlan(sid), [{ type: 'PIECE', pieceSeq: 2, key: key(9, 0, 0) }, la(9, 0, 2, 1)]);
});

test('F-238 ① 멱등 (c): ack 로 지워진 기록의 재시도는 true, 남은 기록과 겹치는 다른 값은 RangeError', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, [piece(1, key(9, 0, 0)), la(9, 0, 1, 1), piece(2, key(10, 0, 0)), la(10, 0, 2, 1)]);
  st.ack(sid, 2); // 1..1 은 지워지고 2..2 는 창 끝 == ackedUpTo 라 남는다
  assert.equal(st.stats(sid).levels, 1);
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 1)), true, 'ack 로 지워진 기록의 재시도(고치기 전: RangeError)');
  assert.equal(st.recordLevelArrived(sid, la(10, 0, 2, 1)), true, '남은 기록과 같은 네 값');
  assert.throws(() => st.recordLevelArrived(sid, la(9, 0, 1, 2)), RangeError, '(b) 창 1..2 는 남은 기록 2..2 와 겹친다');
  assert.throws(() => st.recordLevelArrived(sid, la(11, 0, 2, 1)), RangeError, '(b) 같은 창, 다른 segmentId');
  assert.equal(st.stats(sid).levels, 1);
  st.open({ sessionId: sid, lastPieceSeq: 2 });
  assert.deepEqual(st.resendPlan(sid), [la(10, 0, 2, 1)]);
});

test('F-241 묘비: 지워진 기록 자리의 다른 값은 묘비와 대조해 RangeError, 같은 값만 true', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  send(st, sid, [piece(1, key(9, 0, 0)), piece(2, key(10, 0, 0)), piece(3, key(11, 0, 0)), la(9, 0, 1, 3)]);
  send(st, sid, [piece(4, key(10, 0, 0))]); // seq 2 가 죽어 1..3 기록이 지워진다(묘비)
  assert.equal(st.stats(sid).levels, 0);
  assert.equal(st.recordLevelArrived(sid, la(9, 0, 1, 3)), true, '(a) 묘비와 같은 기록의 재시도');
  // 고치기 전(결정 0033 대가): 죽은 순번을 담은 창은 대조할 정보가 없어 true 였다.
  assert.throws(() => st.recordLevelArrived(sid, la(8, 0, 1, 2)), /겹친다/, '(c) 묘비 1..3 과 다른 값');
  assert.throws(() => st.recordLevelArrived(sid, la(11, 0, 3, 1)), /겹친다/, '(c) 창 3..3 은 앞 창 1..3 과 겹친다');
  assert.equal(st.stats(sid).levels, 0);
  assert.equal(st.recordLevelArrived(sid, la(10, 0, 4, 1)), true, '바로 뒤 창은 새 기록');
  assert.equal(st.stats(sid).levels, 1);
});

test('windowLive 는 resendPlan 과 같은 판정: 추월당한 미확인 조각이 있으면 levels 도 세지 않는다', () => {
  const st = store();
  const sid = st.open({ sessionId: 0 }).sessionId;
  const laCount = () => st.resendPlan(sid).filter((m) => m.type === 'LEVEL_ARRIVED').length;
  // 기록 때 이미 추월당함: 보관은 하지만(F-241 ②, 추월은 ack 로 풀린다) resendPlan·levels 는 세지 않는다.
  send(st, sid, [piece(1, key(9, 1, 0)), piece(2, key(9, 2, 0)), la(9, 1, 1, 1)]);
  assert.equal(st.stats(sid).levels, 0);
  assert.equal(st.levelStats(sid).stored, 1);
  assert.equal(laCount(), 0);
  assert.equal(st.recordLevelArrived(sid, la(9, 1, 1, 1)), true, '(a) 재시도도 true, 바꾸는 것 없음');
  assert.equal(st.stats(sid).levels, 0);
  assert.equal(st.levelStats(sid).stored, 1);
  send(st, sid, [la(9, 2, 2, 1)]);
  assert.equal(st.stats(sid).levels, 1);
  assert.equal(laCount(), 1);
  // 보관한 뒤 추월당함: 기록은 남지만 resendPlan·levels 모두 건너뛴다. 추월당한 조각이 ack 되면 다시 센다.
  send(st, sid, [piece(3, key(10, 0, 0, 1)), piece(4, key(10, 0, 0, 2)), la(10, 0, 3, 2), piece(5, key(10, 1, 0, 1))]);
  st.open({ sessionId: sid, lastPieceSeq: 2 });
  assert.equal(st.stats(sid).levels, 1);
  assert.equal(laCount(), 1);
  st.open({ sessionId: sid, lastPieceSeq: 3 });
  assert.deepEqual(st.resendPlan(sid), [{ type: 'PIECE', pieceSeq: 4, key: key(10, 0, 0, 2) }, la(10, 0, 3, 2), { type: 'PIECE', pieceSeq: 5, key: key(10, 1, 0, 1) }]);
  assert.equal(st.stats(sid).levels, 1);
});
