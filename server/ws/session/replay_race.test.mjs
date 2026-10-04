// 이어받기 재전송 도중 ack·수준 교체가 끼어도 LEVEL_ARRIVED 가 영구히 빠지지 않고 예외로 끊기지 않음을 시험한다(F-241 ⑥·⑨ 유형).
// 계약(./contract.mjs)과 저장소(server/ws/resume) 머리 주석만 보고 쓴 시험이다. 시계·벽시계 단언은 없고 기대값은 손으로 적은 숫자다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../resume/index.mjs';
import { decodeMessage } from '../../../client/proto/index.mjs';
import { createRecordingEmit } from './emit.mjs';
import { replayAfterHello } from './resume.mjs';

const mkStore = () => createSessionStore({ maxSessions: 4, ttlMs: 60_000, now: () => 1000, randomId: () => 77 });
/** 구간 seg 의 수준 0 조각 c, 타일 (tx, -2). */
const key = (seg, c, tx) => ({ segmentId: seg, level: 0, lod: 0, chunkIndex: c, tileX: tx, tileY: -2 });
const chunkOf = (k) => Uint8Array.of(k.chunkIndex + 1, k.tileX & 0xff);
const loadPiece = (k) => chunkOf(k);
const la = (segmentId, firstPieceSeq, pieceCount) => ({ type: 'LEVEL_ARRIVED', segmentId, level: 0, pieceCount, firstPieceSeq });
const piece = (pieceSeq, k) => ({ type: 'PIECE', pieceSeq, key: k, chunk: chunkOf(k) });
const hex = (b) => Buffer.from(b).toString('hex');
/** 비교용: 복호한 메시지에서 chunk 를 뺀다. */
const brief = (m) => (m.type === 'PIECE' ? { type: 'PIECE', pieceSeq: m.pieceSeq, key: m.key } : m);

const K0 = key(9, 0, 1), K1 = key(9, 1, 1); // 구간 9 (타일 1): 순번 1, 2
const K2 = key(10, 0, 2), K3 = key(10, 1, 2); // 구간 10 (타일 2): 순번 3, 4

/** 한 연결의 클라이언트: 받은 바이트를 복호해 쌓는다. dead 면 이후 바이트는 선에서 유실된다. */
function makeWire() {
  const wire = { dead: false, log: [] };
  wire.send = (bytes) => { if (!wire.dead) wire.log.push(decodeMessage(bytes)); };
  return wire;
}

/** 새 세션을 열고 두 수준 묶음(순번 1..2 + LA, 3..4 + LA)을 내보냈으나 선에서 전부 유실된 상태를 만든다. */
function setupLost() {
  const store = mkStore();
  const wire = makeWire();
  const first = replayAfterHello({ store, hello: { sessionId: 0, lastPieceSeq: 0 }, send: wire.send, loadPiece });
  assert.equal(first.resumed, false);
  const sid = first.sessionId;
  wire.dead = true; // 이후 전부 유실
  const emit = createRecordingEmit({ store, sessionId: sid, send: wire.send });
  emit(piece(1, K0)); emit(piece(2, K1)); emit(la(9, 1, 2));
  emit(piece(3, K2)); emit(piece(4, K3)); emit(la(10, 3, 2));
  return { store, sid };
}

test('A: 재전송 send 콜백 안에서 store.ack 가 끼어도 던지지 않고 LEVEL_ARRIVED 가 클라이언트 완료 key 에 들어간다', () => {
  for (const ackTo of [2, 4]) {
    const { store, sid } = setupLost();
    const wire = makeWire();
    let calls = 0;
    const send = (b) => { wire.send(b); calls++; if (calls === 3) store.ack(sid, ackTo); }; // WELCOME, P1, P2 직후
    const r = replayAfterHello({ store, hello: { sessionId: sid, lastPieceSeq: 0 }, send, loadPiece });
    assert.equal(r.resumed, true, `ack ${ackTo}`);
    assert.equal(r.replayed, 6, `ack ${ackTo}: P1 P2 LA P3 P4 LA`);
    const arrived = wire.log.filter((m) => m.type === 'LEVEL_ARRIVED').map(({ segmentId, firstPieceSeq, pieceCount }) => [segmentId, firstPieceSeq, pieceCount]);
    assert.deepEqual(arrived, [[9, 1, 2], [10, 3, 2]], `ack ${ackTo}`);
    // 클라이언트 완료 key: 창 안 조각의 key
    const seqKey = new Map(wire.log.filter((m) => m.type === 'PIECE').map((m) => [m.pieceSeq, m.key.chunkIndex]));
    assert.deepEqual([1, 2].map((s) => seqKey.get(s)), [0, 1]);
    assert.deepEqual([3, 4].map((s) => seqKey.get(s)), [0, 1]);
  }
});

test('B: 재전송 도중 같은 key 를 새 순번으로 대체해도(emit 재진입) 예외 없고, 옛 LEVEL_ARRIVED 는 빠지고 새것이 들어간다', () => {
  const { store, sid } = setupLost();
  const wire = makeWire();
  const emit = createRecordingEmit({ store, sessionId: sid, send: wire.send });
  let calls = 0;
  const send = (b) => {
    wire.send(b); calls++;
    if (calls === 2) { // P1 을 받은 직후: K0 을 순번 5 로 대체하고 새 완료 표시 창 5..5
      emit(piece(5, K0));
      emit(la(9, 5, 1));
    }
  };
  const r = replayAfterHello({ store, hello: { sessionId: sid, lastPieceSeq: 0 }, send, loadPiece });
  assert.equal(r.resumed, true);
  assert.ok(wire.log.some((m) => m.type === 'LEVEL_ARRIVED' && m.firstPieceSeq === 5), '라이브로 낸 새 LEVEL_ARRIVED 가 클라이언트에 도착');
  const plan = store.resendPlan(sid).filter((m) => m.type === 'LEVEL_ARRIVED');
  assert.deepEqual(plan, [la(10, 3, 2), la(9, 5, 1)], '옛 창 1..2 는 빠지고 새 창이 들어간다');
  // 두 번째 이어받기(처음부터): 순번 오름차순, 옛 순번 1 은 없다
  const wire2 = makeWire();
  const r2 = replayAfterHello({ store, hello: { sessionId: sid, lastPieceSeq: 0 }, send: wire2.send, loadPiece });
  assert.equal(r2.replayed, 6);
  assert.deepEqual(wire2.log.map(brief), [
    { type: 'WELCOME', sessionId: sid, resumed: true, nextPieceSeq: 6 },
    brief(piece(2, K1)), brief(piece(3, K2)), brief(piece(4, K3)), la(10, 3, 2), brief(piece(5, K0)), la(9, 5, 1),
  ]);
});

test('C: 같은 HELLO(lastPieceSeq 동일)를 두 번 연속 처리하면 재전송 메시지 열이 바이트까지 같다', () => {
  const { store, sid } = setupLost();
  const run = () => {
    const bytes = [];
    const r = replayAfterHello({ store, hello: { sessionId: sid, lastPieceSeq: 2 }, send: (b) => bytes.push(hex(b)), loadPiece });
    return { r, bytes };
  };
  const a = run(), b = run();
  assert.equal(a.r.resumed, true);
  assert.equal(a.r.replayed, 4, '완료 표시 창 1..2(끝 == ack, 수신 미상), P3, P4, 창 3..4');
  assert.equal(a.bytes.length, 5, 'WELCOME + 4');
  assert.deepEqual(b.bytes, a.bytes);
  assert.equal(b.r.replayed, a.r.replayed);
  assert.equal(b.r.nextPieceSeq, 5);
});

test('D: 재전송 직후 클라이언트 ACK(마지막 순번 4) 뒤 재이어받기는 조각 재전송 0건(창 끝 == ack 인 LEVEL_ARRIVED 하나만)', () => {
  const { store, sid } = setupLost();
  const wire = makeWire();
  const r = replayAfterHello({ store, hello: { sessionId: sid, lastPieceSeq: 0 }, send: wire.send, loadPiece });
  assert.equal(r.replayed, 6);
  store.ack(sid, 4);
  const wire2 = makeWire();
  const r2 = replayAfterHello({ store, hello: { sessionId: sid, lastPieceSeq: 4 }, send: wire2.send, loadPiece });
  assert.equal(r2.resumed, true);
  assert.equal(wire2.log.filter((m) => m.type === 'PIECE').length, 0);
  // 저장소 규약: ackedUpTo == 창 끝이면 조각은 다 받았어도 LEVEL_ARRIVED 수신은 모르므로 남긴다(앞 창 1..2 는 지워진다).
  assert.deepEqual(wire2.log.slice(1), [la(10, 3, 2)]);
  assert.equal(r2.replayed, 1);
});

// ---- 무작위 시험 ----
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 한 시드의 무작위 진행. 위반 목록과 '최종 이어받기 전에 못 받았던 보관 창 수'를 돌려준다. */
function runRandom(seed) {
  const rnd = mulberry32(seed);
  const ri = (n) => Math.floor(rnd() * n);
  const store = mkStore();
  const client = { recv: new Map(), wins: new Set(), max: 0 };
  const model = { keySeq: new Map(), alive: new Set(), wins: [], acked: 0, maxSeq: 0 };
  let conn = null;
  let sid = 0;
  const receive = (c) => (bytes) => {
    if (c.dead) return;
    const m = decodeMessage(bytes);
    if (m.type === 'PIECE') { client.recv.set(m.pieceSeq, true); client.max = Math.max(client.max, m.pieceSeq); }
    else if (m.type === 'LEVEL_ARRIVED') client.wins.add(`${m.segmentId}.${m.firstPieceSeq}.${m.pieceCount}`);
  };
  const emit = createRecordingEmit({ store, sessionId: () => sid, send: (b) => { if (conn) receive(conn)(b); } });
  const winId = (w) => `${w.seg}.${w.first}.${w.count}`;

  // 정직한 클라이언트가 HELLO·ACK 에 싣는 순번: 받은 살아 있는 조각을 빠짐없이 이은 끝, 못 받은 보관 창의 끝을 넘지 않는다.
  const clientL = () => {
    let l = client.max;
    for (const s of model.alive) if (!client.recv.has(s)) l = Math.min(l, s - 1);
    for (const w of model.wins) if (!w.dead && !client.wins.has(winId(w))) l = Math.min(l, w.last);
    return l;
  };
  const emitBatch = () => {
    const tile = 1 + ri(3), n = 1 + ri(3), seg = 20 + tile;
    const first = model.maxSeq + 1;
    for (let c = 0; c < n; c++) {
      const k = key(seg, c, tile);
      const seq = model.maxSeq + 1;
      const ks = `${seg}.${c}`;
      const old = model.keySeq.get(ks);
      if (old !== undefined) {
        model.alive.delete(old);
        if (old > model.acked) for (const w of model.wins) if (w.first <= old && old <= w.last) w.dead = true;
      }
      model.keySeq.set(ks, seq); model.alive.add(seq); model.maxSeq = seq;
      emit(piece(seq, k));
    }
    model.wins.push({ seg, first, count: n, last: first + n - 1, dead: false });
    emit(la(seg, first, n));
  };
  const doAck = () => {
    if (!conn || conn.dead) return;
    const l = clientL();
    model.acked = Math.max(model.acked, l);
    store.ack(sid, l);
  };
  const connect = (withHooks) => {
    if (conn) conn.dead = true;
    const c = { dead: false };
    conn = c;
    const l = sid === 0 ? 0 : clientL();
    if (sid !== 0) model.acked = Math.max(model.acked, l);
    const hookAt = withHooks ? 1 + ri(8) : -1;
    let n = 0;
    const r = replayAfterHello({
      store, hello: { sessionId: sid, lastPieceSeq: l }, loadPiece,
      send: (b) => {
        receive(c)(b); n++;
        if (n === hookAt) { // 재전송 도중 끼어드는 일
          const op = ri(3);
          if (op === 0) doAck(); else if (op === 1) emitBatch(); else c.dead = true;
        }
      },
    });
    if (sid === 0) sid = r.sessionId;
    return r;
  };

  connect(false);
  const steps = 10 + ri(30);
  for (let i = 0; i < steps; i++) {
    const p = ri(100);
    if (p < 40) emitBatch();
    else if (p < 55) doAck();
    else if (p < 70) { if (conn) conn.dead = true; } // 유실: 이후 송출은 선에서 사라진다
    else connect(true);
  }
  const missedBefore = model.wins.filter((w) => !w.dead && w.last >= model.acked && !client.wins.has(winId(w))).length;
  const r = connect(false); // 최종: 끊김 없이 이어받는다
  assert.equal(r.resumed, true);
  const violations = model.wins.filter((w) => !w.dead && w.last >= model.acked && !client.wins.has(winId(w))).map(winId);
  return { violations, missedBefore };
}

test('무작위(시드 1..500): 임의 순서의 송출·ack·유실·재접속 뒤 보관 중이던 창은 모두 클라이언트가 받는다', () => {
  let missedTotal = 0;
  for (let seed = 1; seed <= 500; seed++) {
    const { violations, missedBefore } = runRandom(seed);
    assert.deepEqual(violations, [], `시드 ${seed}`);
    missedTotal += missedBefore;
  }
  assert.ok(missedTotal > 0, '시험이 공전하지 않는다: 최종 이어받기 전에 못 받은 보관 창이 있었다');
});
