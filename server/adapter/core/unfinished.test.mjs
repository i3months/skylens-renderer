// 어댑터 끝나지 않은 이벤트(F-204 방식 b)의 남은 경계(F-219).
//   ① 실패 시점 bytes 는 실제 사본이다(Buffer.slice 는 뷰): 원본을 바꾼 재시도는 다른 이벤트로 거부된다.
//   ② 재시도 때 기계가 외부에서 진행돼 skip 이면 묶였던 순번을 소비하고 표시를 지운다.
//   ③ 실패 사이 ack·축출(maxEntriesPerSession=1)이 끼어도 재시도가 recordSent 에서 막히지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreAdapter, UnfinishedEventError } from './index.mjs';
import { createLevelMachine } from '../../levels/state/index.mjs';
import { pieceKeyString } from '../../../contracts/proto/index.mjs';
import { createSessionStore } from '../../ws/resume/index.mjs';

function key(segmentId, level, c) {
  return { segmentId, level, lod: 0, chunkIndex: c, tileX: segmentId, tileY: c };
}
function piecesEvent(segmentId, level, count) {
  const pieces = [];
  for (let c = 0; c < count; c++) pieces.push({ key: key(segmentId, level, c), bytes: Uint8Array.of(segmentId, level, c, 0xa0) });
  return { kind: 'level_arrived', segmentId, level, pieces };
}
/** 한 pieceSeq 에 key 가 하나뿐인지 검사한다. wire = [[seq, keyString], ...] */
function assertSeqKeyUnique(wire) {
  const keyOfSeq = new Map();
  for (const [seq, ks] of wire) {
    if (keyOfSeq.has(seq)) assert.equal(ks, keyOfSeq.get(seq), `pieceSeq ${seq} 가 두 key 에 쓰였다`);
    else keyOfSeq.set(seq, ks);
  }
  return keyOfSeq;
}

// ── ① Buffer 조각 사본(A9 변이: 사본 대신 참조·Buffer.slice 를 잡는다) ──
for (const kind of ['pool Buffer', 'Buffer.alloc', 'Uint8Array subarray']) {
  test(`F-219 ①: ${kind} 조각으로 실패 -> 원본 변경 -> 재시도는 UnfinishedEventError, 원래 내용으로 재시도하면 복구`, () => {
    let backing, make;
    if (kind === 'pool Buffer') {
      // 작은 Buffer.from 은 공유 pool 위의 뷰다.
      make = (c) => Buffer.from([1, 0, c, 0xa0]);
    } else if (kind === 'Buffer.alloc') {
      backing = Buffer.alloc(64);
      make = (c) => { const b = backing.subarray(c * 4, c * 4 + 4); b.set([1, 0, c, 0xa0]); return b; };
    } else {
      backing = new Uint8Array(64);
      make = (c) => { const b = backing.subarray(c * 4, c * 4 + 4); b.set([1, 0, c, 0xa0]); return b; };
    }
    const pieces = [0, 1].map((c) => ({ key: key(1, 0, c), bytes: make(c) }));
    const ev = { kind: 'level_arrived', segmentId: 1, level: 0, pieces };
    const sent = [];
    let fail = true;
    const ad = createCoreAdapter({
      emit: (m) => {
        if (fail && m.type === 'LEVEL_ARRIVED') throw new Error('송출 실패');
        sent.push(m);
      },
    });
    assert.throws(() => ad.handle(ev), /송출 실패/);
    assert.deepEqual(ad.unfinishedEvent(), { segmentId: 1, level: 0, firstPieceSeq: 1, pieceCount: 2 });

    // 호출자가 원본을 덮어쓴다(같은 객체를 그대로 다시 넣는다).
    const saved = Uint8Array.from(pieces[1].bytes);
    pieces[1].bytes[3] = 0xee;
    fail = false;
    const before = sent.length;
    assert.throws(() => ad.handle(ev), (e) => e instanceof UnfinishedEventError && e.code === 'UNFINISHED_EVENT'
      && e.pending.firstPieceSeq === 1 && e.pending.pieceCount === 2);
    assert.equal(sent.length, before, '거부된 재시도는 아무것도 내보내지 않는다');
    assert.equal(ad.nextPieceSeq(), 1);

    // 원래 내용으로 되돌려 재시도하면 복구된다.
    pieces[1].bytes.set(saved);
    const r = ad.handle(ev);
    assert.deepEqual([r.action, r.emitted], ['first', 3]);
    assert.equal(ad.unfinishedEvent(), null);
    assert.equal(ad.nextPieceSeq(), 3);
    // 같은 pieceSeq·key 로 나간 PIECE 는 모두 같은 내용이다.
    const bySeq = new Map();
    for (const m of sent.filter((x) => x.type === 'PIECE')) {
      const bytes = Array.from(m.chunk);
      if (bySeq.has(m.pieceSeq)) assert.deepEqual(bytes, bySeq.get(m.pieceSeq), `pieceSeq ${m.pieceSeq} 내용이 다르다`);
      else bySeq.set(m.pieceSeq, bytes);
    }
  });
}

// ── ② 재시도 때 기계가 외부에서 진행돼 skip ──────────────────────────
for (const extLevel of [0, 1]) {
  test(`F-219 ②: 실패 뒤 기계가 외부에서 수준 ${extLevel} 로 진행 -> 재시도는 skip, 순번 소비·표시 해제, 다음 이벤트는 새 순번`, () => {
    const machine = createLevelMachine();
    const wire = [];
    let fail = true;
    const ad = createCoreAdapter({
      levelMachine: machine,
      emit: (m) => {
        if (m.type === 'PIECE') wire.push([m.pieceSeq, pieceKeyString(m.key)]);
        if (fail && m.type === 'LEVEL_ARRIVED') throw new Error('송출 실패');
      },
    });
    assert.throws(() => ad.handle(piecesEvent(1, 0, 2)), /송출 실패/);
    assert.deepEqual(ad.unfinishedEvent(), { segmentId: 1, level: 0, firstPieceSeq: 1, pieceCount: 2 });
    // 어댑터를 거치지 않고 기계를 진행시킨다.
    machine.arrive(1, extLevel, piecesEvent(1, extLevel, 1).pieces);
    fail = false;

    const n = wire.length;
    const r = ad.handle(piecesEvent(1, 0, 2));
    assert.deepEqual(r, { action: 'skip', emitted: 0, released: [] });
    assert.equal(wire.length, n, 'skip 은 아무것도 내보내지 않는다');
    assert.equal(ad.unfinishedEvent(), null, '끝나지 않은 표시가 지워진다');
    assert.equal(ad.nextPieceSeq(), 3, '실패한 시도에 묶였던 pieceSeq 1·2 는 소비된다');

    // 다른 이벤트가 막히지 않고, 소비된 순번을 다른 key 로 다시 쓰지 않는다.
    assert.deepEqual(ad.handle({ kind: 'segment_expected', segmentId: 5 }).action, 'expect');
    const r2 = ad.handle(piecesEvent(2, 0, 2));
    assert.deepEqual([r2.action, r2.emitted], ['first', 3]);
    assert.equal(ad.nextPieceSeq(), 5);
    const keyOfSeq = assertSeqKeyUnique(wire);
    assert.deepEqual([...keyOfSeq.keys()].sort((a, b) => a - b), [1, 2, 3, 4]);
    assert.equal(keyOfSeq.get(3), pieceKeyString(key(2, 0, 0)));
  });
}

test('F-219 ②: 끝나지 않은 이벤트가 없을 때 skip 은 순번을 소비하지 않는다', () => {
  const ad = createCoreAdapter({ emit: () => {} });
  ad.handle(piecesEvent(1, 1, 2));
  assert.equal(ad.nextPieceSeq(), 3);
  assert.equal(ad.handle(piecesEvent(1, 0, 2)).action, 'skip');
  assert.equal(ad.nextPieceSeq(), 3);
});

// ── ③ 실패 사이 ack·축출(maxEntriesPerSession=1) ─────────────────────
test('F-219 ③: 재시도 사이 ack·축출로 항목이 지워져도 recordSent 가 막히지 않고 재시도로 복구', () => {
  const store = createSessionStore({ maxSessions: 2, ttlMs: 1000, now: () => 0, randomId: () => 7, maxEntriesPerSession: 1 });
  const { sessionId, nextPieceSeq } = store.open({ sessionId: 0, lastPieceSeq: 0 });
  const wire = [];
  let failOn = null; // (m) => boolean: 기록 전에 던질 메시지
  const ad = createCoreAdapter({
    firstPieceSeq: nextPieceSeq,
    emit: (m) => {
      if (m.type === 'PIECE') wire.push([m.pieceSeq, pieceKeyString(m.key)]);
      if (failOn && failOn(m)) throw new Error('송출 실패');
      if (m.type === 'PIECE' && !store.recordSent(sessionId, m.key, m.pieceSeq, m.chunk)) throw new Error('recordSent 거부');
    },
  });
  const ev = () => piecesEvent(1, 0, 2);

  // 시도 1: seq 1 기록, seq 2 기록 전에 실패.
  failOn = (m) => m.type === 'PIECE' && m.pieceSeq === 2;
  assert.throws(() => ad.handle(ev()), /송출 실패/);
  store.ack(sessionId, 1);
  // 시도 2: seq 1 멱등, seq 2 기록(항목 상한 1 → ack 된 seq 1 축출), LEVEL_ARRIVED 실패.
  failOn = (m) => m.type === 'LEVEL_ARRIVED';
  assert.throws(() => ad.handle(ev()), /송출 실패/);
  assert.equal(store.stats(sessionId).entries, 1);
  // 시도 3: seq 1 항목은 축출됐지만 seq <= ackedUpTo 라 멱등 true. 끝까지 나간다.
  failOn = null;
  const r = ad.handle(ev());
  assert.deepEqual([r.action, r.emitted], ['first', 3]);
  assert.equal(ad.unfinishedEvent(), null);
  assert.equal(ad.nextPieceSeq(), 3);
  assert.deepEqual(store.unacked(sessionId).map((u) => [u.seq, pieceKeyString(u.key)]), [[2, pieceKeyString(key(1, 0, 1))]]);
  assertSeqKeyUnique(wire);
});

test('F-219 ③: recordSent — 항목 없는 ack 된 순번은 멱등 true(상태 그대로), ack 안 된 역행·다른 순번은 여전히 RangeError', () => {
  const store = createSessionStore({ maxSessions: 2, ttlMs: 1000, now: () => 0, randomId: () => 7, maxEntriesPerSession: 1 });
  const { sessionId } = store.open({ sessionId: 0, lastPieceSeq: 0 });
  const A = key(1, 0, 0), B = key(1, 0, 1), C = key(1, 0, 2);
  assert.equal(store.recordSent(sessionId, A, 1, Uint8Array.of(1)), true);
  store.ack(sessionId, 1);
  assert.equal(store.recordSent(sessionId, B, 2, Uint8Array.of(2, 2)), true); // A 축출
  const before = store.stats(sessionId);
  assert.equal(store.recordSent(sessionId, A, 1, Uint8Array.of(1)), true);
  assert.deepEqual(store.stats(sessionId), before, '아무것도 바꾸지 않는다');
  assert.equal(store.shouldSend(sessionId, B), false);
  // ack 되지 않은 순번(2)을 항목 없는 key 로: RangeError
  assert.throws(() => store.recordSent(sessionId, C, 2, Uint8Array.of(3)), RangeError);
  // 항목이 있는 key 를 다른 낮은 순번으로: RangeError
  assert.throws(() => store.recordSent(sessionId, B, 1, Uint8Array.of(2, 2)), RangeError);
  assert.equal(store.recordSent(sessionId, C, 3, Uint8Array.of(3)), false, '미확인 B 만 있어 상한 안으로 못 줄인다');
});
