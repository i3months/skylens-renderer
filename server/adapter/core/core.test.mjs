import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCoreAdapter, MAX_PIECE_BYTES, UnfinishedEventError } from './index.mjs';
import { createLevelMachine as createServerMachine } from '../../levels/state/index.mjs';
import { createLevelMachine as createClientMachine } from '../../../client/levels/index.mjs';
import { MSG, PROTO_VERSION, FRAME_HEADER_BYTES, PIECE_SEQ_MIN, pieceKeyString } from '../../../contracts/proto/index.mjs';
import { SEGMENT_ID_LIMIT } from '../../../contracts/asset/index.mjs';
import { createSessionStore } from '../../ws/resume/index.mjs';

// ── 코덱 ─────────────────────────────────────────────────────────────
// 서버 코덱(server/proto/codec, 부호화)과 클라이언트 코덱(client/proto, s→c 복호)이 있으면 그것을 쓴다.
// 없으면 contracts/proto 의 s→c 배치(PIECE·LEVEL_ARRIVED·MISSING)만 아는 시험용 최소 코덱을 쓴다.
function fallbackEncode(m) {
  let body;
  if (m.type === 'MISSING') {
    body = new Uint8Array(4); new DataView(body.buffer).setUint32(0, m.segmentId, true);
  } else if (m.type === 'LEVEL_ARRIVED') {
    body = new Uint8Array(9); const v = new DataView(body.buffer);
    v.setUint32(0, m.segmentId, true); v.setUint8(4, m.level); v.setUint32(5, m.pieceCount, true);
  } else if (m.type === 'PIECE') {
    body = new Uint8Array(20 + m.chunk.length); const v = new DataView(body.buffer);
    v.setUint32(0, m.pieceSeq, true);
    v.setUint32(4, m.key.segmentId, true); v.setUint8(8, m.key.level); v.setUint8(9, m.key.lod);
    v.setUint16(10, m.key.chunkIndex, true); v.setInt32(12, m.key.tileX, true); v.setInt32(16, m.key.tileY, true);
    body.set(m.chunk, 20);
  } else throw new Error(`시험 코덱이 모르는 종류: ${m.type}`);
  const out = new Uint8Array(FRAME_HEADER_BYTES + body.length);
  const h = new DataView(out.buffer);
  h.setUint8(0, MSG[m.type]); h.setUint8(1, PROTO_VERSION); h.setUint16(2, 0, true); h.setUint32(4, body.length, true);
  out.set(body, FRAME_HEADER_BYTES);
  return out;
}
function fallbackDecode(bytes) {
  const h = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = h.getUint8(0);
  assert.equal(h.getUint32(4, true), bytes.length - FRAME_HEADER_BYTES);
  const v = new DataView(bytes.buffer, bytes.byteOffset + FRAME_HEADER_BYTES, bytes.length - FRAME_HEADER_BYTES);
  if (type === MSG.MISSING) return { type: 'MISSING', segmentId: v.getUint32(0, true) };
  if (type === MSG.LEVEL_ARRIVED) {
    return { type: 'LEVEL_ARRIVED', segmentId: v.getUint32(0, true), level: v.getUint8(4), pieceCount: v.getUint32(5, true) };
  }
  if (type === MSG.PIECE) {
    return {
      type: 'PIECE', pieceSeq: v.getUint32(0, true),
      key: { segmentId: v.getUint32(4, true), level: v.getUint8(8), lod: v.getUint8(9), chunkIndex: v.getUint16(10, true),
        tileX: v.getInt32(12, true), tileY: v.getInt32(16, true) },
      chunk: bytes.slice(FRAME_HEADER_BYTES + 20),
    };
  }
  throw new Error(`시험 코덱이 모르는 type: ${type}`);
}
async function tryImport(rel) {
  try { return await import(new URL(rel, import.meta.url).href); } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw e;
  }
}
const serverCodec = await tryImport('../../proto/codec/index.mjs');
const clientCodec = await tryImport('../../../client/proto/index.mjs');
const encode = serverCodec ? serverCodec.encodeMessage : fallbackEncode;
const decode = clientCodec ? clientCodec.decodeMessage : fallbackDecode;

// ── 합성 녹화 ───────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEGMENTS = 20;
const LEVELS = 4;
const DUPLICATES = 8;
const EXPECT_ONLY = [100, 101, 102];

/** 수준 L 의 조각은 L+1 개. 바이트는 (구간, 수준, 조각) 으로 정해지는 값. */
function levelEvent(segmentId, level) {
  const pieces = [];
  for (let c = 0; c <= level; c++) {
    const bytes = new Uint8Array(3 + c);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (segmentId * 31 + level * 7 + c * 3 + i) & 0xff;
    pieces.push({ key: { segmentId, level, lod: level, chunkIndex: c, tileX: segmentId - 10, tileY: -c }, bytes });
  }
  return { kind: 'level_arrived', segmentId, level, pieces };
}

function makeRecording(seed) {
  const rnd = mulberry32(seed);
  const ev = [];
  for (let s = 0; s < SEGMENTS; s++) for (let l = 0; l < LEVELS; l++) ev.push(levelEvent(s, l));
  for (let s = 0; s < SEGMENTS; s += 2) ev.push({ kind: 'segment_expected', segmentId: s });
  for (const s of EXPECT_ONLY) ev.push({ kind: 'segment_expected', segmentId: s });
  // Fisher–Yates
  for (let i = ev.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [ev[i], ev[j]] = [ev[j], ev[i]];
  }
  // 중복: 이미 나온 level_arrived 를 그 뒤 임의 위치에 한 번 더 넣는다(반드시 skip).
  for (let d = 0; d < DUPLICATES; d++) {
    let i;
    do { i = Math.floor(rnd() * ev.length); } while (ev[i].kind !== 'level_arrived');
    const j = i + 1 + Math.floor(rnd() * (ev.length - i));
    ev.splice(j, 0, ev[i]);
  }
  return ev;
}

/** 독립 참조: 구간별 최고 수준을 따라가며 이벤트마다 기대 결과를 낸다. */
function reference(rec) {
  const best = new Map();
  const out = [];
  for (const e of rec) {
    if (e.kind === 'segment_expected') { out.push(best.has(e.segmentId) ? 'expect-quiet' : 'expect-missing'); continue; }
    const cur = best.get(e.segmentId);
    if (cur === undefined) { best.set(e.segmentId, e.level); out.push('first'); }
    else if (e.level > cur) { best.set(e.segmentId, e.level); out.push('replace'); }
    else out.push('skip');
  }
  return out;
}

/** 받은 메시지(복호 결과)를 클라이언트 기계에 같은 순서로 먹인다. PIECE 를 모아 두었다가 LEVEL_ARRIVED 에서 arrive. */
function createClientFeeder() {
  const machine = createClientMachine();
  const pending = new Map();
  let lastSeq = PIECE_SEQ_MIN - 1;
  return {
    machine,
    feed(m) {
      if (m.type === 'MISSING') { machine.expect(m.segmentId); return; }
      if (m.type === 'PIECE') {
        assert.equal(m.pieceSeq, lastSeq + 1, 'pieceSeq 는 1씩 증가');
        lastSeq = m.pieceSeq;
        const id = `${m.key.segmentId}:${m.key.level}`;
        if (!pending.has(id)) pending.set(id, []);
        pending.get(id).push({ key: m.key, chunk: m.chunk });
        return;
      }
      if (m.type === 'LEVEL_ARRIVED') {
        const id = `${m.segmentId}:${m.level}`;
        const got = pending.get(id) || [];
        pending.delete(id);
        assert.equal(got.length, m.pieceCount);
        const r = machine.arrive(m.segmentId, m.level, got);
        assert.notEqual(r.action, 'skip', '서버가 보낸 수준은 클라이언트에서도 추월당하지 않는다');
        return;
      }
      throw new Error(`예상 밖 메시지: ${m.type}`);
    },
    pendingCount: () => pending.size,
  };
}

function replay(rec, { viaCodec }) {
  const server = createServerMachine();
  const released = [];
  const out = [];
  const adapter = createCoreAdapter({
    levelMachine: server,
    emit: (m) => out.push(m),
    encode: viaCodec ? encode : undefined,
    onRelease: (keys, info) => released.push({ keys, info }),
  });
  const results = [];
  const perEvent = [];
  for (const e of rec) {
    const before = out.length;
    const r = adapter.handle(e);
    results.push(r);
    perEvent.push(out.length - before);
    assert.equal(r.emitted, out.length - before);
  }
  return { server, out, released, results, perEvent, adapter };
}

function assertSameState(server, client, segs) {
  for (const s of segs) {
    const a = server.snapshot(s), b = client.snapshot(s);
    assert.deepEqual([b.level, b.pieces.length, b.missing], [a.level, a.pieces.length, a.missing], `구간 ${s}`);
    assert.deepEqual(b.pieces.map((p) => pieceKeyString(p.key)), a.pieces.map((p) => pieceKeyString(p.key)), `구간 ${s} 조각 key`);
    for (let i = 0; i < a.pieces.length; i++) assert.deepEqual([...b.pieces[i].chunk], [...a.pieces[i].bytes]);
  }
}

for (const seed of [7, 2026, 0xbeef]) {
  test(`녹화 재생(시드 ${seed}): 서버·클라이언트 상태 일치, skip 은 emit 0, 교체 후 최고 수준만`, () => {
    const rec = makeRecording(seed);
    assert.equal(rec.length, 80 + 10 + 3 + 8);
    const ref = reference(rec);
    const skips = ref.filter((a) => a === 'skip').length;
    const overtakes = rec.filter((e, i) => ref[i] === 'skip' && e.kind === 'level_arrived').length - DUPLICATES;
    assert.ok(skips >= DUPLICATES, '중복은 모두 skip');
    assert.ok(overtakes > 0, '녹화에 추월이 있어야 한다');

    for (const viaCodec of [false, true]) {
      const { server, out, released, results, perEvent } = replay(rec, { viaCodec });
      // 이벤트별 결과가 독립 참조와 같다
      results.forEach((r, i) => {
        const want = ref[i];
        if (want === 'expect-missing') assert.deepEqual([r.action, perEvent[i]], ['expect', 1]);
        else if (want === 'expect-quiet') assert.deepEqual([r.action, perEvent[i]], ['expect', 0]);
        else if (want === 'skip') assert.deepEqual([r.action, perEvent[i]], ['skip', 0]);
        else assert.deepEqual([r.action, perEvent[i]], [want, rec[i].level + 2]);
      });
      // 교체 알림: replace 수와 같고, 알린 key 는 이전 수준(previousLevel) 조각 previousLevel+1 개
      assert.equal(released.length, ref.filter((a) => a === 'replace').length);
      for (const { keys, info } of released) {
        assert.equal(keys.length, info.previousLevel + 1);
        for (const k of keys) assert.deepEqual([k.segmentId, k.level], [info.segmentId, info.previousLevel]);
      }

      const feeder = createClientFeeder();
      for (const m of out) feeder.feed(viaCodec ? decode(m) : m);
      assert.equal(feeder.pendingCount(), 0);

      const all = [...Array(SEGMENTS).keys(), ...EXPECT_ONLY];
      assertSameState(server, feeder.machine, all);
      assert.deepEqual(feeder.machine.segments(), server.segments());
      assert.deepEqual(server.segments(), all);
      // 설계상 정답: 0..19 는 모두 수준 3, 조각 4 개(누적 0). 100..102 는 없음, 조각 0.
      for (let s = 0; s < SEGMENTS; s++) {
        const c = feeder.machine.snapshot(s);
        assert.deepEqual([c.level, c.pieces.length, c.missing, c.final], [3, 4, false, true]);
        assert.ok(c.pieces.every((p) => p.key.level === 3));
      }
      for (const s of EXPECT_ONLY) {
        const c = feeder.machine.snapshot(s);
        assert.deepEqual([c.level, c.pieces.length, c.missing], [-1, 0, true]);
      }
    }
  });
}

test('고정 사례: 정확한 메시지 순서와 수', () => {
  const out = [];
  const rel = [];
  const ad = createCoreAdapter({ emit: (m) => out.push(m), onRelease: (k, info) => rel.push([k, info]) });
  assert.deepEqual(ad.handle({ kind: 'segment_expected', segmentId: 5 }), { action: 'expect', emitted: 1, released: [] });
  assert.deepEqual(out.splice(0), [{ type: 'MISSING', segmentId: 5 }]);

  const l2 = levelEvent(5, 2); // 조각 3 개
  let r = ad.handle(l2);
  assert.deepEqual([r.action, r.emitted], ['first', 4]);
  assert.deepEqual(out.map((m) => m.type), ['PIECE', 'PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  assert.deepEqual(out.slice(0, 3).map((m) => m.pieceSeq), [1, 2, 3]);
  assert.deepEqual(out[3], { type: 'LEVEL_ARRIVED', segmentId: 5, level: 2, pieceCount: 3 });
  assert.equal(out[0].chunk, l2.pieces[0].bytes);
  out.length = 0;

  r = ad.handle(levelEvent(5, 0)); // 추월
  assert.deepEqual([r.action, r.emitted, out.length], ['skip', 0, 0]);
  r = ad.handle(levelEvent(5, 2)); // 중복
  assert.deepEqual([r.action, r.emitted, out.length], ['skip', 0, 0]);
  assert.equal(ad.nextPieceSeq(), 4, 'skip 은 순번을 쓰지 않는다');

  r = ad.handle(levelEvent(5, 3)); // 교체, 조각 4 개
  assert.deepEqual([r.action, r.emitted], ['replace', 5]);
  assert.deepEqual(out.filter((m) => m.type === 'PIECE').map((m) => m.pieceSeq), [4, 5, 6, 7]);
  assert.equal(rel.length, 1);
  assert.deepEqual(rel[0][0].map((k) => k.chunkIndex), [0, 1, 2]);
  assert.deepEqual(rel[0][1], { segmentId: 5, level: 3, previousLevel: 2 });
  out.length = 0;

  // 도착한 구간을 다시 expect 해도 MISSING 을 보내지 않는다
  r = ad.handle({ kind: 'segment_expected', segmentId: 5 });
  assert.deepEqual([r.emitted, out.length], [0, 0]);
});

test('firstPieceSeq 와 u32 넘침 거부', () => {
  const out = [];
  const ad = createCoreAdapter({ emit: (m) => out.push(m), firstPieceSeq: 0xfffffffe });
  ad.handle(levelEvent(1, 1)); // 조각 2 개: 0xfffffffe, 0xffffffff
  assert.deepEqual(out.filter((m) => m.type === 'PIECE').map((m) => m.pieceSeq), [0xfffffffe, 0xffffffff]);
  assert.throws(() => ad.handle(levelEvent(2, 0)), RangeError);
  assert.equal(out.length, 3, '거부된 이벤트는 아무것도 내보내지 않는다');
  assert.throws(() => createCoreAdapter({ emit() {}, firstPieceSeq: 2 ** 32 }), RangeError);
});

test('firstPieceSeq 기본값은 PIECE_SEQ_MIN(1), 0·비정상 값은 RangeError (F-184)', () => {
  assert.equal(PIECE_SEQ_MIN, 1);
  const out = [];
  const ad = createCoreAdapter({ emit: (m) => out.push(m) });
  assert.equal(ad.nextPieceSeq(), 1);
  ad.handle(levelEvent(3, 0));
  assert.deepEqual(out.map((m) => [m.type, m.pieceSeq]), [['PIECE', 1], ['LEVEL_ARRIVED', undefined]]);
  for (const bad of [0, -1, 1.5, NaN, Infinity, '1', null, 2 ** 32]) {
    assert.throws(() => createCoreAdapter({ emit() {}, firstPieceSeq: bad }), RangeError, String(bad));
  }
  const one = [];
  createCoreAdapter({ emit: (m) => one.push(m), firstPieceSeq: 1 }).handle(levelEvent(3, 0));
  assert.equal(one[0].pieceSeq, 1);
});

test('어댑터 첫 PIECE 를 이어받기 저장소에 기록하면 lastPieceSeq 0 재접속에서 재전송 후보가 된다 (F-184)', () => {
  let t = 0;
  const store = createSessionStore({ maxSessions: 4, ttlMs: 1000, now: () => t, randomId: () => 77 });
  const { sessionId, nextPieceSeq } = store.open({ sessionId: 0, lastPieceSeq: 0 });
  const out = [];
  const ad = createCoreAdapter({ emit: (m) => out.push(m), firstPieceSeq: nextPieceSeq });
  ad.handle(levelEvent(4, 0));
  const piece = out.find((m) => m.type === 'PIECE');
  assert.equal(piece.pieceSeq, 1);
  assert.equal(store.recordSent(sessionId, piece.key, piece.pieceSeq, piece.chunk), true);
  t = 10;
  const re = store.open({ sessionId, lastPieceSeq: 0 });
  assert.equal(re.resumed, true);
  assert.deepEqual(store.unacked(sessionId), [{ seq: 1, key: piece.key }]);
  assert.equal(store.shouldSend(sessionId, piece.key), true);
});

// ── 송출 실패와 상태 확정(F-189) ─────────────────────────────────────
/** k 번째 emit 호출(1부터, 시도마다 다시 센다)에서 던지는 송출기. 성공한 시도의 메시지만 committed 에 남긴다. */
function flakyHarness({ viaCodec = false } = {}) {
  const server = createServerMachine();
  const committed = [];
  const attempt = [];
  const released = [];
  let failAt = 0;
  let calls = 0;
  const boom = new Error('emit 실패');
  const adapter = createCoreAdapter({
    levelMachine: server,
    encode: viaCodec ? encode : undefined,
    emit: (m) => {
      calls++;
      if (calls === failAt) throw boom;
      attempt.push(m);
    },
    onRelease: (keys, info) => released.push({ keys, info }),
  });
  return {
    server, committed, attempt, released, adapter, boom,
    run(ev, k = 0) {
      failAt = k; calls = 0; attempt.length = 0;
      try {
        const r = adapter.handle(ev);
        committed.push(...attempt.map((m) => (viaCodec ? decode(m) : m)));
        return r;
      } finally { failAt = 0; }
    },
  };
}

function stateOf(server, seg) {
  const s = server.snapshot(seg);
  return { level: s.level, missing: s.missing, keys: s.pieces.map((p) => pieceKeyString(p.key)) };
}

for (const viaCodec of [false, true]) {
  for (const prior of [null, 1]) {
    const want = prior === null ? 'first' : 'replace';
    for (const which of ['1번째', '2번째', '마지막']) {
      test(`emit 이 ${which}에 던지면 상태·순번 불변, 재시도는 ${want}, pieceSeq 끊김·중복 없음 (codec=${viaCodec})`, () => {
        const h = flakyHarness({ viaCodec });
        if (prior !== null) assert.equal(h.run(levelEvent(9, prior)).action, 'first');
        const ev = levelEvent(9, 3); // 조각 4 개 + LEVEL_ARRIVED = 메시지 5 개
        const k = { '1번째': 1, '2번째': 2, '마지막': 5 }[which];
        const before = stateOf(h.server, 9);
        const seqBefore = h.adapter.nextPieceSeq();
        const relBefore = h.released.length;

        assert.throws(() => h.run(ev, k), (e) => e === h.boom);
        assert.equal(h.attempt.length, k - 1, '던지기 전까지 나간 수');
        assert.deepEqual(stateOf(h.server, 9), before, '기계 상태 불변');
        assert.equal(h.adapter.nextPieceSeq(), seqBefore, 'nextSeq 불변');
        assert.equal(h.released.length, relBefore, '실패한 시도는 onRelease 를 부르지 않는다');

        const r = h.run(ev);
        assert.deepEqual([r.action, r.emitted], [want, 5]);
        assert.deepEqual(h.attempt.slice(-5).map((m) => (viaCodec ? decode(m) : m).type),
          ['PIECE', 'PIECE', 'PIECE', 'PIECE', 'LEVEL_ARRIVED']);
        assert.deepEqual(h.attempt.slice(0, 4).map((m) => (viaCodec ? decode(m) : m).pieceSeq),
          [seqBefore, seqBefore + 1, seqBefore + 2, seqBefore + 3]);
        assert.equal(h.adapter.nextPieceSeq(), seqBefore + 4);
        assert.deepEqual(stateOf(h.server, 9).level, 3);
        assert.equal(h.released.length, relBefore + (prior === null ? 0 : 1));
        // 같은 이벤트를 또 넣으면 이제는 중복이라 skip
        assert.equal(h.run(ev).action, 'skip');
        // 다음 구간도 이어서 매긴다
        h.run(levelEvent(10, 0));
        const seqs = h.committed.filter((m) => m.type === 'PIECE').map((m) => m.pieceSeq);
        assert.deepEqual(seqs, seqs.map((_, i) => PIECE_SEQ_MIN + i), '성공한 송출의 pieceSeq 는 1부터 끊김·중복 없음');
        // 받는 쪽 기계가 서버와 같은 상태가 된다
        const feeder = createClientFeeder();
        for (const m of h.committed) feeder.feed(m);
        assertSameState(h.server, feeder.machine, [9, 10]);
      });
    }
  }
}

// ── emit 안에서 resume.recordSent 를 부르는 배선(F-197) ──────────────
// 'before': 기록 전에 던짐(기록 안 됨). 'after': 기록 뒤 소켓 쓰기에서 던짐(기록됐지만 나가지 않음).
for (const viaCodec of [false, true]) {
  for (const where of ['before', 'after']) {
    test(`F-197: emit 에서 recordSent, n 번째 emit 실패 뒤 재시도 -> 전부 나가고 unacked 순번 빈칸·중복 없음 (${where}, codec=${viaCodec})`, () => {
      const prior = levelEvent(9, 1); // 조각 2 개(seq 1, 2), 먼저 성공
      const ev = levelEvent(9, 3); // 조각 4 개 + LEVEL_ARRIVED = 메시지 5 개 (교체)
      for (let n = 1; n <= 5; n++) {
        const store = createSessionStore({ maxSessions: 4, ttlMs: 1000, now: () => 0, randomId: () => 5 });
        const { sessionId, nextPieceSeq } = store.open({ sessionId: 0, lastPieceSeq: 0 });
        const delivered = [];
        let calls = 0;
        let failAt = 0;
        const boom = new Error('송출 실패');
        const ad = createCoreAdapter({
          encode: viaCodec ? encode : undefined,
          firstPieceSeq: nextPieceSeq,
          emit: (raw) => {
            calls++;
            const m = viaCodec ? decode(raw) : raw;
            if (where === 'before' && calls === failAt) throw boom;
            if (m.type === 'PIECE') {
              if (!store.recordSent(sessionId, m.key, m.pieceSeq, m.chunk)) throw new Error('recordSent 거부');
            }
            if (where === 'after' && calls === failAt) throw boom;
            delivered.push(m);
          },
        });
        assert.equal(ad.handle(prior).action, 'first');
        failAt = n; calls = 0;
        assert.throws(() => ad.handle(ev), (e) => e === boom, `n=${n}`);
        failAt = 0;
        const r = ad.handle(ev); // 재시도: 같은 pieceSeq·key 를 다시 기록해도 막히지 않는다
        assert.deepEqual([r.action, r.emitted], ['replace', 5], `n=${n}`);
        // 재시도 시도의 메시지 5 개가 전부 나갔다: PIECE 4 개(seq 3..6) + LEVEL_ARRIVED
        const last = delivered.slice(-5);
        assert.deepEqual(last.map((m) => [m.type, m.pieceSeq]),
          [['PIECE', 3], ['PIECE', 4], ['PIECE', 5], ['PIECE', 6], ['LEVEL_ARRIVED', undefined]], `n=${n}`);
        assert.deepEqual(last[4], { type: 'LEVEL_ARRIVED', segmentId: 9, level: 3, pieceCount: 4 });
        assert.deepEqual(last.slice(0, 4).map((m) => pieceKeyString(m.key)), ev.pieces.map((p) => pieceKeyString(p.key)));
        // unacked: 1..6 빈칸·중복 없음, key 도 그 순서
        const un = store.unacked(sessionId);
        assert.deepEqual(un.map((u) => u.seq), [1, 2, 3, 4, 5, 6], `n=${n}`);
        assert.deepEqual(un.map((u) => pieceKeyString(u.key)),
          [...prior.pieces, ...ev.pieces].map((p) => pieceKeyString(p.key)));
        // 보관 바이트는 조각마다 한 번만 센다
        const bytes = [...prior.pieces, ...ev.pieces].reduce((a, p) => a + p.bytes.length, 0);
        assert.deepEqual(store.stats(sessionId), { entries: 6, retainedBytes: bytes, unacked: 6, groups: 6 });
        assert.equal(ad.nextPieceSeq(), 7);
        assert.equal(store.open({ sessionId, lastPieceSeq: 0 }).nextPieceSeq, 7, 'WELCOME 순번 = 어댑터 다음 순번');
      }
    });
  }
}

// ── 송출 실패 뒤 다른 이벤트(F-204) ──────────────────────────────────
// 한 pieceSeq 는 서로 다른 두 key 에 쓰이지 않는다. 송출 중 실패한 이벤트가 있으면 다른 이벤트는 UnfinishedEventError 로
// 거부되고(아무것도 나가지 않음), 같은 이벤트를 다시 넣어야 풀린다.
/** 구간 segmentId 수준 level 의 조각 count 개 이벤트(chunkIndex 0..count-1). */
function piecesEvent(segmentId, level, count, salt = 0) {
  const pieces = [];
  for (let c = 0; c < count; c++) {
    const bytes = Uint8Array.of(segmentId, level, c, 0xa0 + salt);
    pieces.push({ key: { segmentId, level, lod: 0, chunkIndex: c, tileX: segmentId, tileY: c }, bytes });
  }
  return { kind: 'level_arrived', segmentId, level, pieces };
}

// 구간 1 수준 0 (조각 2 개: seq 1, 2) + LEVEL_ARRIVED = emit 3 번. 실패 지점 n:
//   n=1: 1번째 emit(PIECE seq1) 기록 전에 던짐     n=2: PIECE seq1 기록 뒤 던짐
//   n=3: 2번째 emit(PIECE seq2) 기록 전에 던짐     n=4: PIECE seq2 기록 뒤 던짐
//   n=5: PIECE seq1·2 는 송출·recordSent 성공, 3번째 emit(LEVEL_ARRIVED) 송출 실패(과제의 시나리오)
//   n=6: LEVEL_ARRIVED 를 쓴 뒤 던짐
const F204_POINTS = [
  { n: 1, call: 1, where: 'before', unackedWhileBlocked: [] },
  { n: 2, call: 1, where: 'after', unackedWhileBlocked: [1] },
  { n: 3, call: 2, where: 'before', unackedWhileBlocked: [1] },
  { n: 4, call: 2, where: 'after', unackedWhileBlocked: [1, 2] },
  { n: 5, call: 3, where: 'before', unackedWhileBlocked: [1, 2] },
  { n: 6, call: 3, where: 'after', unackedWhileBlocked: [1, 2] },
];
for (const viaCodec of [false, true]) {
  for (const pt of F204_POINTS) {
    test(`F-204: 실패 지점 n=${pt.n}(${pt.call}번째 emit ${pt.where}) 뒤 다른 구간 이벤트 -> UNFINISHED_EVENT, 같은 이벤트 재시도로 복구, pieceSeq 한 key 전용·unacked 1..4 (codec=${viaCodec})`, () => {
      const store = createSessionStore({ maxSessions: 4, ttlMs: 1000, now: () => 0, randomId: () => 9 });
      const { sessionId, nextPieceSeq } = store.open({ sessionId: 0, lastPieceSeq: 0 });
      assert.equal(nextPieceSeq, 1);
      const wire = []; // emit 에 넘어온 모든 PIECE(실패한 시도 포함): [seq, keyString]
      const delivered = []; // 끝까지 나간 메시지
      let calls = 0;
      let failAt = 0;
      const boom = new Error('송출 실패');
      const ad = createCoreAdapter({
        encode: viaCodec ? encode : undefined,
        firstPieceSeq: nextPieceSeq,
        emit: (raw) => {
          calls++;
          const m = viaCodec ? decode(raw) : raw;
          if (m.type === 'PIECE') wire.push([m.pieceSeq, pieceKeyString(m.key)]);
          if (pt.where === 'before' && calls === failAt) throw boom;
          if (m.type === 'PIECE') {
            if (!store.recordSent(sessionId, m.key, m.pieceSeq, m.chunk)) throw new Error('recordSent 거부');
          }
          if (pt.where === 'after' && calls === failAt) throw boom;
          delivered.push(m);
        },
      });
      const ev1 = piecesEvent(1, 0, 2);
      const ev2 = piecesEvent(2, 0, 2);

      failAt = pt.call; calls = 0;
      assert.throws(() => ad.handle(ev1), (e) => e === boom, `n=${pt.n}`);
      failAt = 0;
      assert.equal(calls, pt.call, `n=${pt.n}: 실패까지 emit ${pt.call} 번`);
      assert.deepEqual(ad.unfinishedEvent(), { segmentId: 1, level: 0, firstPieceSeq: 1, pieceCount: 2 });
      assert.equal(ad.nextPieceSeq(), 1);
      assert.deepEqual(store.unacked(sessionId).map((u) => u.seq), pt.unackedWhileBlocked, `n=${pt.n}`);

      // 다른 구간 이벤트: 정해진 오류, 아무것도 나가지 않고 순번·unacked 그대로
      const blocked = [
        ev2,
        { kind: 'segment_expected', segmentId: 2 },
        piecesEvent(1, 1, 2), // 같은 구간 다른 수준
        piecesEvent(1, 0, 1), // 같은 구간·수준, 조각 수 다름
        piecesEvent(1, 0, 2, 1), // 같은 key, 다른 bytes
      ];
      for (const [i, ev] of blocked.entries()) {
        calls = 0;
        assert.throws(() => ad.handle(ev), (e) => e instanceof UnfinishedEventError && e.code === 'UNFINISHED_EVENT'
          && e.pending.segmentId === 1 && e.pending.level === 0 && e.pending.firstPieceSeq === 1 && e.pending.pieceCount === 2,
        `n=${pt.n} 거부 ${i}`);
        assert.equal(calls, 0, `n=${pt.n} 거부 ${i}: emit 0 번`);
      }
      assert.equal(ad.nextPieceSeq(), 1);
      assert.deepEqual(store.unacked(sessionId).map((u) => u.seq), pt.unackedWhileBlocked, `n=${pt.n}: 거부 뒤 unacked 그대로`);

      // 복구: 같은 이벤트(다른 객체지만 같은 내용) 재시도
      const r1 = ad.handle(piecesEvent(1, 0, 2));
      assert.deepEqual([r1.action, r1.emitted], ['first', 3], `n=${pt.n}`);
      assert.equal(ad.unfinishedEvent(), null);
      assert.equal(ad.nextPieceSeq(), 3);
      const r2 = ad.handle(ev2);
      assert.deepEqual([r2.action, r2.emitted], ['first', 3], `n=${pt.n}`);
      assert.equal(ad.nextPieceSeq(), 5);

      // 선에 나간 기록: 한 pieceSeq 에 key 는 하나뿐
      const keyOfSeq = new Map();
      for (const [seq, ks] of wire) {
        if (keyOfSeq.has(seq)) assert.equal(ks, keyOfSeq.get(seq), `n=${pt.n}: pieceSeq ${seq} 가 두 key 에 쓰였다`);
        else keyOfSeq.set(seq, ks);
      }
      const keys = [...ev1.pieces, ...ev2.pieces].map((p) => pieceKeyString(p.key));
      assert.deepEqual([...keyOfSeq.entries()].sort((a, b) => a[0] - b[0]), [[1, keys[0]], [2, keys[1]], [3, keys[2]], [4, keys[3]]]);

      // resume.unacked: 1..4 빈칸·중복 없음, key 도 그 순서
      const un = store.unacked(sessionId);
      assert.deepEqual(un.map((u) => u.seq), [1, 2, 3, 4], `n=${pt.n}`);
      assert.deepEqual(un.map((u) => pieceKeyString(u.key)), keys);
      assert.equal(store.stats(sessionId).entries, 4);
      assert.equal(store.open({ sessionId, lastPieceSeq: 0 }).nextPieceSeq, 5, 'WELCOME 순번 = 어댑터 다음 순번');

      // 받는 쪽: 같은 pieceSeq·key 재전송은 하나로 센다. 그러면 서버와 같은 상태가 된다.
      const feeder = createClientFeeder();
      let lastSeq = 0;
      for (const m of delivered) {
        if (m.type === 'PIECE' && m.pieceSeq <= lastSeq) continue;
        if (m.type === 'PIECE') lastSeq = m.pieceSeq;
        if (m.type === 'LEVEL_ARRIVED' && feeder.machine.snapshot(m.segmentId).level >= m.level) continue; // 다시 온 완료 표시
        feeder.feed(m);
      }
      assert.deepEqual([1, 2].map((s) => feeder.machine.snapshot(s).pieces.length), [2, 2], `n=${pt.n}`);
    });
  }
}

test('F-204: 끝나지 않은 이벤트가 없으면 거부하지 않고, 재시도 성공 뒤 같은 이벤트는 skip', () => {
  const out = [];
  let fail = true;
  const ad = createCoreAdapter({ emit: (m) => { if (fail && m.type === 'LEVEL_ARRIVED') throw new Error('x'); out.push(m); } });
  assert.equal(ad.unfinishedEvent(), null);
  assert.throws(() => ad.handle(piecesEvent(1, 0, 2)), /x/);
  assert.throws(() => ad.handle({ kind: 'segment_expected', segmentId: 7 }), UnfinishedEventError);
  fail = false;
  assert.equal(ad.handle(piecesEvent(1, 0, 2)).action, 'first');
  assert.equal(ad.handle(piecesEvent(1, 0, 2)).action, 'skip');
  assert.equal(ad.handle({ kind: 'segment_expected', segmentId: 7 }).emitted, 1);
  assert.deepEqual(out.filter((m) => m.type === 'PIECE').map((m) => m.pieceSeq), [1, 2, 1, 2]);
});

test('F-203: 빈 pieces 는 거부, 이전 수준·순번 그대로이고 아무것도 나가지 않는다', () => {
  const server = createServerMachine();
  const out = [];
  const rel = [];
  const ad = createCoreAdapter({ levelMachine: server, emit: (m) => out.push(m), onRelease: (k) => rel.push(k) });
  assert.throws(() => ad.handle({ kind: 'level_arrived', segmentId: 6, level: 0, pieces: [] }), RangeError); // 첫 도착도 빈 것은 거부
  assert.deepEqual([out.length, server.snapshot(6).level, ad.nextPieceSeq()], [0, -1, PIECE_SEQ_MIN]);
  ad.handle(levelEvent(6, 1)); // 조각 2 개
  out.length = 0;
  for (const level of [2, 3, 1, 0]) {
    assert.throws(() => ad.handle({ kind: 'level_arrived', segmentId: 6, level, pieces: [] }), RangeError, `level ${level}`);
  }
  assert.deepEqual(out, [], 'pieceCount 0 LEVEL_ARRIVED 를 내보내지 않는다');
  assert.deepEqual(rel, [], '이전 조각을 놓지 않는다');
  assert.deepEqual(stateOf(server, 6), {
    level: 1, missing: false, keys: levelEvent(6, 1).pieces.map((p) => pieceKeyString(p.key)),
  });
  assert.equal(ad.nextPieceSeq(), PIECE_SEQ_MIN + 2);
  assert.equal(ad.handle(levelEvent(6, 2)).action, 'replace'); // 조각이 있는 높은 수준은 그대로 교체
});

test('encode 가 던지면 아무것도 나가지 않고 상태·순번 불변', () => {
  const server = createServerMachine();
  const out = [];
  let n = 0;
  const ad = createCoreAdapter({
    levelMachine: server,
    emit: (m) => out.push(m),
    encode: (m) => { if (++n === 3) throw new Error('encode 실패'); return encode(m); },
  });
  assert.throws(() => ad.handle(levelEvent(2, 2)), /encode 실패/);
  assert.deepEqual([out.length, server.snapshot(2).level, ad.nextPieceSeq()], [0, -1, PIECE_SEQ_MIN]);
  assert.equal(ad.unfinishedEvent(), null, '부호화 실패는 아무것도 내보내지 않았으므로 끝나지 않은 이벤트로 남지 않는다');
  assert.equal(ad.handle(levelEvent(2, 2)).action, 'first');
  assert.equal(out.length, 4);
});

test('onRelease: 하나가 던져도 전부 부르고 다시 던진다. 상태는 확정된다', () => {
  const server = createServerMachine();
  const out = [];
  const calls = [];
  const e1 = new Error('첫 알림 실패');
  const ad = createCoreAdapter({
    levelMachine: server,
    emit: (m) => out.push(m),
    onRelease: [() => { calls.push('a'); throw e1; }, (keys, info) => calls.push(['b', keys.length, info.previousLevel])],
  });
  ad.handle(levelEvent(6, 0));
  assert.throws(() => ad.handle(levelEvent(6, 2)), (e) => e === e1);
  assert.deepEqual(calls, ['a', ['b', 1, 0]]);
  assert.equal(server.snapshot(6).level, 2, '메시지는 다 나갔으므로 상태는 확정');
  assert.equal(ad.nextPieceSeq(), PIECE_SEQ_MIN + 4);
  assert.deepEqual(out.map((m) => m.type), ['PIECE', 'LEVEL_ARRIVED', 'PIECE', 'PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  assert.equal(ad.handle(levelEvent(6, 2)).action, 'skip');

  // 둘 이상 던지면 AggregateError 로 모두 전한다
  const e2 = new Error('둘째 실패');
  const third = [];
  const ad2 = createCoreAdapter({ emit() {}, onRelease: [() => { throw e1; }, () => { throw e2; }, (k) => third.push(k.length)] });
  ad2.handle(levelEvent(7, 0));
  assert.throws(() => ad2.handle(levelEvent(7, 1)), (e) => e instanceof AggregateError && e.errors[0] === e1 && e.errors[1] === e2);
  assert.deepEqual(third, [1]);
  assert.throws(() => createCoreAdapter({ emit() {}, onRelease: [() => {}, 3] }), TypeError);
});

test('상한값 수용: segmentId SEGMENT_ID_LIMIT-1, chunkIndex 0xffff (F-195)', () => {
  const top = SEGMENT_ID_LIMIT - 1;
  for (const viaCodec of [false, true]) {
    const server = createServerMachine();
    const out = [];
    const ad = createCoreAdapter({ levelMachine: server, emit: (m) => out.push(m), encode: viaCodec ? encode : undefined });
    assert.deepEqual(ad.handle({ kind: 'segment_expected', segmentId: top }), { action: 'expect', emitted: 1, released: [] });
    const key = { segmentId: top, level: 0, lod: 0, chunkIndex: 0xffff, tileX: 0, tileY: 0 };
    const r = ad.handle({ kind: 'level_arrived', segmentId: top, level: 0, pieces: [{ key, bytes: new Uint8Array([5]) }] });
    assert.deepEqual([r.action, r.emitted], ['first', 2]);
    const msgs = out.map((m) => (viaCodec ? decode(m) : m));
    assert.deepEqual(msgs[0], { type: 'MISSING', segmentId: top });
    assert.equal(msgs[1].type, 'PIECE');
    assert.deepEqual(msgs[1].key, key);
    assert.deepEqual(msgs[2], { type: 'LEVEL_ARRIVED', segmentId: top, level: 0, pieceCount: 1 });
    assert.equal(server.snapshot(top).level, 0);
  }
  // 한 칸 넘으면 거부
  const ad = createCoreAdapter({ emit() {} });
  assert.throws(() => ad.handle({ kind: 'segment_expected', segmentId: SEGMENT_ID_LIMIT }), RangeError);
  assert.throws(() => ad.handle({ kind: 'level_arrived', segmentId: SEGMENT_ID_LIMIT, level: 0, pieces: [] }), RangeError);
});

test('입력 검사: 범위 밖은 RangeError, 상태는 그대로', () => {
  const server = createServerMachine();
  const out = [];
  const ad = createCoreAdapter({ levelMachine: server, emit: (m) => out.push(m) });
  const bad = [
    { kind: 'nope', segmentId: 1 },
    { kind: 'segment_expected', segmentId: -1 },
    { kind: 'segment_expected', segmentId: 2 ** 30 },
    { kind: 'level_arrived', segmentId: 1, level: 4, pieces: [] },
    { kind: 'level_arrived', segmentId: 1, level: -1, pieces: [] },
  ];
  for (const e of bad) assert.throws(() => ad.handle(e), RangeError);
  const withPiece = (patch, bytes = new Uint8Array(1)) => {
    const e = levelEvent(1, 0);
    e.pieces[0] = { key: { ...e.pieces[0].key, ...patch }, bytes };
    return e;
  };
  assert.throws(() => ad.handle(withPiece({ segmentId: 2 })), RangeError);
  assert.throws(() => ad.handle(withPiece({ level: 1 })), RangeError);
  assert.throws(() => ad.handle(withPiece({ lod: 8 })), RangeError);
  assert.throws(() => ad.handle(withPiece({ chunkIndex: 65536 })), RangeError);
  assert.throws(() => ad.handle(withPiece({ tileX: 2 ** 31 })), RangeError);
  assert.throws(() => ad.handle(withPiece({}, new Uint8Array(0))), RangeError);
  assert.throws(() => ad.handle(withPiece({}, { length: MAX_PIECE_BYTES + 1, __proto__: Uint8Array.prototype })), RangeError);
  const dup = levelEvent(1, 1);
  dup.pieces[1] = { key: { ...dup.pieces[0].key }, bytes: new Uint8Array(2) };
  assert.throws(() => ad.handle(dup), RangeError);
  // 모양 오류는 TypeError
  assert.throws(() => ad.handle(null), TypeError);
  assert.throws(() => ad.handle({ kind: 'segment_expected', segmentId: 1.5 }), TypeError);
  assert.throws(() => ad.handle({ kind: 'level_arrived', segmentId: 1, level: 0 }), TypeError);
  assert.throws(() => ad.handle(withPiece({}, [1, 2])), TypeError);
  assert.throws(() => createCoreAdapter({}), TypeError);
  // 아무것도 바뀌거나 나가지 않았다
  assert.deepEqual([out.length, server.segments().length, ad.nextPieceSeq()], [0, 0, PIECE_SEQ_MIN]);
});

test('시간·타이머를 쓰지 않는다', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.mjs', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const w of ['setTimeout', 'setInterval', 'setImmediate', 'Date', 'performance', 'requestAnimationFrame', 'queueMicrotask']) {
    assert.ok(!src.includes(w), w);
  }
});
