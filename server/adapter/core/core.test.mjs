import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCoreAdapter, MAX_PIECE_BYTES } from './index.mjs';
import { createLevelMachine as createServerMachine } from '../../levels/state/index.mjs';
import { createLevelMachine as createClientMachine } from '../../../client/levels/index.mjs';
import { MSG, PROTO_VERSION, FRAME_HEADER_BYTES, pieceKeyString } from '../../../contracts/proto/index.mjs';

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
  let lastSeq = -1;
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
  assert.deepEqual(out.slice(0, 3).map((m) => m.pieceSeq), [0, 1, 2]);
  assert.deepEqual(out[3], { type: 'LEVEL_ARRIVED', segmentId: 5, level: 2, pieceCount: 3 });
  assert.equal(out[0].chunk, l2.pieces[0].bytes);
  out.length = 0;

  r = ad.handle(levelEvent(5, 0)); // 추월
  assert.deepEqual([r.action, r.emitted, out.length], ['skip', 0, 0]);
  r = ad.handle(levelEvent(5, 2)); // 중복
  assert.deepEqual([r.action, r.emitted, out.length], ['skip', 0, 0]);
  assert.equal(ad.nextPieceSeq(), 3, 'skip 은 순번을 쓰지 않는다');

  r = ad.handle(levelEvent(5, 3)); // 교체, 조각 4 개
  assert.deepEqual([r.action, r.emitted], ['replace', 5]);
  assert.deepEqual(out.filter((m) => m.type === 'PIECE').map((m) => m.pieceSeq), [3, 4, 5, 6]);
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
  assert.deepEqual([out.length, server.segments().length, ad.nextPieceSeq()], [0, 0, 0]);
});

test('시간·타이머를 쓰지 않는다', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.mjs', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const w of ['setTimeout', 'setInterval', 'setImmediate', 'Date', 'performance', 'requestAnimationFrame', 'queueMicrotask']) {
    assert.ok(!src.includes(w), w);
  }
});
