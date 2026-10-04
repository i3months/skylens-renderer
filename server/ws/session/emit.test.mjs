// createRecordingEmit 시험(T12.U S1). 실제 어댑터(server/adapter/core)·이어받기 저장소(server/ws/resume)·코덱을 잇는다.
// 기대값은 손으로 적은 숫자다. 송출 순서는 프레임 머리 첫 바이트(MSG 종류)로 읽는다(decodeMessage 는 c→s 만 받는다).
// 변이 확인: LEVEL_ARRIVED 기록을 지우면 ①·②·③ 이, 기록을 send 뒤로 옮기면 ② 가 실패한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingEmit, RecordRejectedError } from './emit.mjs';
import { createCoreAdapter, UnfinishedEventError } from '../../adapter/core/index.mjs';
import { createSessionStore } from '../resume/index.mjs';
import { encodeMessage } from '../../proto/codec/index.mjs';
import { MSG_NAMES } from '../../../contracts/proto/index.mjs';

const T0 = 1000;
const mkStore = () => createSessionStore({ maxSessions: 4, ttlMs: 60_000, now: () => T0, randomId: () => 77 });
const key = (seg, level, c) => ({ segmentId: seg, level, lod: 0, chunkIndex: c, tileX: seg, tileY: c });
function arrived(segmentId, level, count) {
  const pieces = [];
  for (let c = 0; c < count; c++) pieces.push({ key: key(segmentId, level, c), bytes: Uint8Array.of(segmentId, level, c, 0xa0) });
  return { kind: 'level_arrived', segmentId, level, pieces };
}
const typeOf = (bytes) => MSG_NAMES[bytes[0]];
const la = (segmentId, level, firstPieceSeq, pieceCount) => ({ type: 'LEVEL_ARRIVED', segmentId, level, firstPieceSeq, pieceCount });

/** 저장소·세션·어댑터를 잇는다. sendImpl(bytes, wire) 는 wire 에 넣기 전에 불린다(던지면 실패, 'drop' 이면 유실). */
function wire(sendImpl = () => undefined) {
  const store = mkStore();
  const sid = store.open({ sessionId: 0, lastPieceSeq: 0 }).sessionId;
  const sent = [];
  const send = (bytes) => {
    const r = sendImpl(bytes, sent);
    if (r !== 'drop') sent.push(typeOf(bytes));
    return false; // 배압 신호 흉내: 반환값은 실패가 아니다
  };
  const emit = createRecordingEmit({ store, sessionId: sid, send });
  const adapter = createCoreAdapter({ emit });
  return { store, sid, sent, adapter };
}

test('① level_arrived 한 건(조각 3): entries 3, stored 1, 송출 PIECE×3 → LEVEL_ARRIVED', () => {
  const { store, sid, sent, adapter } = wire();
  const r = adapter.handle(arrived(5, 0, 3));
  assert.equal(r.action, 'first');
  assert.equal(r.emitted, 4);
  assert.equal(store.stats(sid).entries, 3);
  assert.equal(store.levelStats(sid).stored, 1);
  assert.deepEqual(sent, ['PIECE', 'PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  assert.equal(store.stats(sid).levels, 1);
});

test('② LEVEL_ARRIVED 에서 send 가 던지면 UNFINISHED, 같은 이벤트 재시도 성공, levels 기록 1(중복 없음)', () => {
  let failLa = true;
  const { store, sid, sent, adapter } = wire((bytes) => {
    if (failLa && typeOf(bytes) === 'LEVEL_ARRIVED') throw new Error('선 끊김');
  });
  assert.throws(() => adapter.handle(arrived(5, 0, 2)), /선 끊김/);
  assert.deepEqual(adapter.unfinishedEvent(), { segmentId: 5, level: 0, firstPieceSeq: 1, pieceCount: 2 });
  assert.throws(() => adapter.handle({ kind: 'segment_expected', segmentId: 6 }), UnfinishedEventError);
  // 기록은 send 보다 먼저라 실패한 시도에서도 이미 남아 있다
  assert.equal(store.levelStats(sid).stored, 1);
  failLa = false;
  const r = adapter.handle(arrived(5, 0, 2));
  assert.equal(r.action, 'first');
  assert.equal(adapter.unfinishedEvent(), null);
  assert.equal(adapter.nextPieceSeq(), 3);
  assert.equal(store.stats(sid).entries, 2);
  assert.equal(store.levelStats(sid).stored, 1);
  assert.equal(store.stats(sid).levels, 1);
  assert.deepEqual(sent, ['PIECE', 'PIECE', 'PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  const plan = store.resendPlan(sid).filter((m) => m.type === 'LEVEL_ARRIVED');
  assert.deepEqual(plan, [la(5, 0, 1, 2)]);
});

test('③ LEVEL_ARRIVED 가 선에서 유실돼도 기록이 남아 resendPlan 에 LEVEL_ARRIVED 1개', () => {
  const { store, sid, sent, adapter } = wire((bytes) => (typeOf(bytes) === 'LEVEL_ARRIVED' ? 'drop' : undefined));
  const r = adapter.handle(arrived(5, 0, 2));
  assert.equal(r.action, 'first');
  assert.deepEqual(sent, ['PIECE', 'PIECE']);
  // 클라이언트가 조각 2개를 받고 끊긴 뒤 이어받기
  const o = store.open({ sessionId: sid, lastPieceSeq: 2 });
  assert.equal(o.resumed, true);
  const plan = store.resendPlan(sid);
  assert.deepEqual(plan, [la(5, 0, 1, 2)]);
  assert.equal(plan.filter((m) => m.type === 'LEVEL_ARRIVED').length, 1);
});

test('④ recordSent 가 false 면 send 하지 않고 RecordRejectedError', () => {
  const calls = [];
  const store = {
    recordSent: (...a) => { calls.push(['recordSent', ...a]); return false; },
    recordLevelArrived: () => { throw new Error('불리면 안 된다'); },
  };
  let sends = 0;
  const emit = createRecordingEmit({ store, sessionId: 9, send: () => { sends++; } });
  const chunk = Uint8Array.of(1, 2, 3);
  assert.throws(() => emit({ type: 'PIECE', pieceSeq: 4, key: key(1, 0, 0), chunk }),
    (e) => e instanceof RecordRejectedError && e.code === 'RECORD_REJECTED' && e.method === 'recordSent' && e.sessionId === 9);
  assert.equal(sends, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ['recordSent', 9, key(1, 0, 0), 4]);
  assert.equal(calls[0][4], chunk);
});

test('④ recordLevelArrived 가 false 면 send 하지 않고 RecordRejectedError, 넘긴 기록은 네 값', () => {
  const recs = [];
  const store = {
    recordSent: () => true,
    recordLevelArrived: (sid, rec) => { recs.push([sid, rec]); return false; },
  };
  let sends = 0;
  const emit = createRecordingEmit({ store, sessionId: () => 11, send: () => { sends++; } });
  assert.throws(() => emit(la(3, 1, 7, 2)),
    (e) => e instanceof RecordRejectedError && e.method === 'recordLevelArrived' && e.sessionId === 11);
  assert.equal(sends, 0);
  assert.deepEqual(recs, [[11, { segmentId: 3, level: 1, firstPieceSeq: 7, pieceCount: 2 }]]);
});

test('④ 실제 저장소: 모르는 세션이면 recordSent false → send 0회, 어댑터는 UNFINISHED', () => {
  const store = mkStore();
  let sends = 0;
  const emit = createRecordingEmit({ store, sessionId: 12345, send: () => { sends++; } });
  const adapter = createCoreAdapter({ emit });
  assert.throws(() => adapter.handle(arrived(5, 0, 2)), RecordRejectedError);
  assert.equal(sends, 0);
  assert.equal(adapter.unfinishedEvent().pieceCount, 2);
});

test('⑤ MISSING 은 기록 없이 send(부호화된 바이트 그대로)', () => {
  const store = {
    recordSent: () => { throw new Error('불리면 안 된다'); },
    recordLevelArrived: () => { throw new Error('불리면 안 된다'); },
  };
  const out = [];
  const emit = createRecordingEmit({ store, sessionId: () => { throw new Error('세션도 묻지 않는다'); }, send: (b) => { out.push(b); } });
  emit({ type: 'MISSING', segmentId: 8 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], encodeMessage({ type: 'MISSING', segmentId: 8 }));
});

test('⑤ 어댑터 segment_expected → MISSING 1건, 실제 저장소 entries 0·stored 0', () => {
  const { store, sid, sent, adapter } = wire();
  const r = adapter.handle({ kind: 'segment_expected', segmentId: 6 });
  assert.equal(r.emitted, 1);
  assert.deepEqual(sent, ['MISSING']);
  assert.equal(store.stats(sid).entries, 0);
  assert.equal(store.levelStats(sid).stored, 0);
});

test('부호화가 던지면 기록·송출 없음', () => {
  let recorded = 0, sends = 0;
  const store = { recordSent: () => { recorded++; return true; }, recordLevelArrived: () => { recorded++; return true; } };
  const emit = createRecordingEmit({ store, sessionId: 1, send: () => { sends++; }, encode: () => { throw new RangeError('부호화 실패'); } });
  assert.throws(() => emit(la(1, 0, 1, 1)), /부호화 실패/);
  assert.equal(recorded, 0);
  assert.equal(sends, 0);
});

test('저장소가 던진 RangeError 는 그대로 전파하고 send 하지 않는다', () => {
  const store = mkStore();
  const sid = store.open({ sessionId: 0, lastPieceSeq: 0 }).sessionId;
  let sends = 0;
  const emit = createRecordingEmit({ store, sessionId: sid, send: () => { sends++; } });
  // 조각 기록 없이 LEVEL_ARRIVED: 저장소가 '조각 먼저 기록' RangeError
  assert.throws(() => emit(la(1, 0, 1, 1)), RangeError);
  assert.equal(sends, 0);
});

test('기록 규칙이 없는 type 은 TypeError, 잘못된 옵션은 TypeError', () => {
  const store = mkStore();
  const emit = createRecordingEmit({ store, sessionId: 1, send: () => {} });
  assert.throws(() => emit({ type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq: 1 }), TypeError);
  assert.throws(() => emit(null), TypeError);
  assert.throws(() => createRecordingEmit({ store, sessionId: 1.5, send: () => {} }), TypeError);
  assert.throws(() => createRecordingEmit({ store: {}, sessionId: 1, send: () => {} }), TypeError);
  assert.throws(() => createRecordingEmit({ store, sessionId: 1 }), TypeError);
  assert.throws(() => createRecordingEmit({ store, sessionId: 1, send: () => {}, encode: 3 }), TypeError);
  const bad = createRecordingEmit({ store, sessionId: () => 'x', send: () => {} });
  assert.throws(() => bad({ type: 'PIECE', pieceSeq: 1, key: key(1, 0, 0), chunk: Uint8Array.of(1) }), TypeError);
});
