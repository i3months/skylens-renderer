import test from 'node:test';
import assert from 'node:assert/strict';
import { completedKeys, collectArrivals, pieceKeyToString } from './arrival.mjs';
import { selectDrawable, ClientRasterError } from './index.mjs';
import { encodeChunkKey } from '../../server/asset/ids/index.mjs';
import { createCoreAdapter } from '../../server/adapter/core/index.mjs';
import { createLevelMachine } from '../../server/levels/state/index.mjs';
import { encodeMessage } from '../../server/proto/codec/index.mjs';
import { decodeMessage } from '../../client/proto/index.mjs';

// 수준 도착 완료 key 집합(F-230) 검사.
// server/adapter/core 를 실제로 돌려 낸 메시지를 서버 코덱으로 부호화하고 클라이언트 코덱으로 복호한 뒤
// collectArrivals → selectDrawable 에 넣는다. 기준값은 손으로 적은 key 문자열이다.

const isPiece = (e) => e instanceof ClientRasterError && e.code === 'piece';

/** 구간 seg 수준 level 의 조각 이벤트. 조각 c 의 key 는 (lod 0, chunkIndex c, tile (1, −2)). */
function event(seg, level, chunks) {
  return {
    kind: 'level_arrived', segmentId: seg, level,
    pieces: chunks.map((c) => ({ key: { segmentId: seg, level, lod: 0, chunkIndex: c, tileX: 1, tileY: -2 }, bytes: Uint8Array.of(seg, level, c, 0x5a) })),
  };
}

/**
 * 어댑터 + 선. emit 은 부호화된 바이트를 받는다. fail = {call, where}: call 번째 emit 에서 'before'(선에 쓰기 전) 또는
 * 'after'(선에 쓴 뒤) 던진다. 선(wire)은 실제로 쓰인 프레임만 담는다.
 */
function harness({ machine = createLevelMachine(), firstPieceSeq } = {}) {
  const wire = [];
  const released = [];
  let fail = null;
  let calls = 0;
  const adapter = createCoreAdapter({
    levelMachine: machine, encode: encodeMessage, firstPieceSeq,
    emit: (bytes) => {
      calls += 1;
      if (fail && fail.where === 'before' && calls === fail.call) throw new Error('송출 실패');
      wire.push(bytes);
      if (fail && fail.where === 'after' && calls === fail.call) throw new Error('송출 실패');
    },
    onRelease: (keys, info) => released.push({ keys, info }),
  });
  return {
    adapter, machine, wire, released,
    run(ev, f = null) { fail = f; calls = 0; try { return adapter.handle(ev); } finally { fail = null; } },
    decoded: () => wire.map((b) => decodeMessage(b)),
  };
}

test('pieceKeyToString 은 server/asset/ids encodeChunkKey 와 같은 문자열', () => {
  const cases = [
    [{ segmentId: 7, level: 2, lod: 0, chunkIndex: 0, tileX: 1, tileY: -2 }, '7.2.1.-2.0.0'],
    [{ segmentId: 0, level: 0, lod: 0, chunkIndex: 0, tileX: -0, tileY: 0 }, '0.0.0.0.0.0'],
    [{ segmentId: 1073741823, level: 3, lod: 7, chunkIndex: 65535, tileX: 2147483647, tileY: -2147483648 }, '1073741823.3.2147483647.-2147483648.7.65535'],
  ];
  for (const [k, want] of cases) {
    assert.equal(pieceKeyToString(k), want);
    assert.equal(pieceKeyToString(k), encodeChunkKey(k));
    // 선을 거친 PieceKey 도 같다
    const m = decodeMessage(encodeMessage({ type: 'PIECE', pieceSeq: 1, key: k, chunk: Uint8Array.of(1) }));
    assert.equal(pieceKeyToString(m.key), want);
  }
  for (const bad of [
    null, { segmentId: 1073741824, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 },
    { segmentId: 7, level: 4, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 },
    { segmentId: 7, level: 0, lod: 8, chunkIndex: 0, tileX: 0, tileY: 0 },
    { segmentId: 7, level: 0, lod: 0, chunkIndex: 65536, tileX: 0, tileY: 0 },
    { segmentId: 7, level: 0, lod: 0, chunkIndex: 0, tileX: 2147483648, tileY: 0 },
    { segmentId: 7, level: 0, lod: 0, chunkIndex: 0.5, tileX: 0, tileY: 0 },
  ]) assert.throws(() => pieceKeyToString(bad), isPiece, JSON.stringify(bad));
});

test('정상 1수준 도착: 어댑터 → 코덱 → collectArrivals → selectDrawable, 모든 key 를 그린다', () => {
  const h = harness();
  assert.equal(h.run(event(7, 2, [0, 1, 2])).action, 'first');
  const msgs = h.decoded();
  assert.deepEqual(msgs.map((m) => m.type), ['PIECE', 'PIECE', 'PIECE', 'LEVEL_ARRIVED']);
  const { keys, arrived } = collectArrivals(msgs);
  assert.deepEqual(keys, ['7.2.1.-2.0.0', '7.2.1.-2.0.1', '7.2.1.-2.0.2']);
  assert.deepEqual(arrived, [{ segmentId: 7, level: 2, keys: ['7.2.1.-2.0.0', '7.2.1.-2.0.1', '7.2.1.-2.0.2'] }]);
  // completedKeys 직접 호출도 같다
  assert.deepEqual(completedKeys(msgs.slice(0, 3), msgs[3]), ['7.2.1.-2.0.0', '7.2.1.-2.0.1', '7.2.1.-2.0.2']);
  assert.deepEqual(selectDrawable(keys, arrived), { draw: ['7.2.1.-2.0.0', '7.2.1.-2.0.1', '7.2.1.-2.0.2'], pending: [], discard: [] });
  // LEVEL_ARRIVED 전까지는 그리지 않는다
  const early = collectArrivals(msgs.slice(0, 3));
  assert.deepEqual(selectDrawable(early.keys, early.arrived), { draw: [], pending: ['7.2.1.-2.0.0', '7.2.1.-2.0.1', '7.2.1.-2.0.2'], discard: [] });
  // 이어 들어온 높은 수준: 낮은 수준은 버린다
  assert.equal(h.run(event(7, 3, [0, 1])).action, 'replace');
  const all = collectArrivals(h.decoded());
  assert.deepEqual(all.arrived[1], { segmentId: 7, level: 3, keys: ['7.3.1.-2.0.0', '7.3.1.-2.0.1'] });
  assert.deepEqual(selectDrawable(all.keys, all.arrived), {
    draw: ['7.3.1.-2.0.0', '7.3.1.-2.0.1'], pending: [], discard: ['7.2.1.-2.0.0', '7.2.1.-2.0.1', '7.2.1.-2.0.2'],
  });
});

test('같은 이벤트 재시도(재전송)는 같은 pieceSeq·key 라 한 조각으로 센다', () => {
  // 1) 둘째 PIECE 를 쓰기 전에 실패 → 재시도: 선 P1, P1 P2 P3 LA
  // 2) LEVEL_ARRIVED 를 쓴 뒤 실패 → 재시도: 선 P1 P2 P3 LA, P1 P2 P3 LA(완료 표시 두 번, 같은 창)
  for (const [f, types, nArrived] of [
    [{ call: 2, where: 'before' }, ['PIECE', 'PIECE', 'PIECE', 'PIECE', 'LEVEL_ARRIVED'], 1],
    [{ call: 4, where: 'after' }, ['PIECE', 'PIECE', 'PIECE', 'LEVEL_ARRIVED', 'PIECE', 'PIECE', 'PIECE', 'LEVEL_ARRIVED'], 2],
  ]) {
    const h = harness();
    assert.throws(() => h.run(event(7, 1, [0, 1, 2]), f), /송출 실패/);
    assert.equal(h.run(event(7, 1, [0, 1, 2])).action, 'first');
    const msgs = h.decoded();
    assert.deepEqual(msgs.map((m) => m.type), types, f.where);
    assert.deepEqual(msgs.filter((m) => m.type === 'PIECE').map((m) => m.pieceSeq), types[3] === 'LEVEL_ARRIVED' ? [1, 2, 3, 1, 2, 3] : [1, 1, 2, 3]);
    const { keys, arrived } = collectArrivals(msgs);
    assert.deepEqual(keys, ['7.1.1.-2.0.0', '7.1.1.-2.0.1', '7.1.1.-2.0.2']);
    assert.equal(arrived.length, nArrived);
    for (const a of arrived) assert.deepEqual(a, { segmentId: 7, level: 1, keys: ['7.1.1.-2.0.0', '7.1.1.-2.0.1', '7.1.1.-2.0.2'] });
    assert.deepEqual(selectDrawable(keys, arrived), { draw: ['7.1.1.-2.0.0', '7.1.1.-2.0.1', '7.1.1.-2.0.2'], pending: [], discard: [] });
  }
});

test('abandoned 섞인 재시도(F-223 ①): 어댑터가 abandoned 로 알린 key 는 discard, 뒤 수준은 draw', () => {
  const machine = createLevelMachine();
  const h = harness({ machine });
  // 수준 1 조각 3 개 중 둘째 PIECE 에서 실패: 선에는 P1(c0) 만
  assert.throws(() => h.run(event(9, 1, [0, 1, 2]), { call: 2, where: 'before' }), /송출 실패/);
  machine.arrive(9, 2, event(9, 2, [0]).pieces); // 다른 경로로 더 높은 수준 확정(공유 기계)
  const r = h.run(event(9, 1, [0, 1, 2]));
  assert.equal(r.action, 'skip');
  assert.deepEqual(r.abandoned.map(pieceKeyToString), ['9.1.1.-2.0.0', '9.1.1.-2.0.1', '9.1.1.-2.0.2']);
  assert.equal(h.released.length, 1);
  assert.equal(h.released[0].info.abandoned, true);
  assert.equal(h.adapter.nextPieceSeq(), 4, 'pieceSeq 1..3 은 태운다');
  // 이 구간의 다음 수준은 이 선으로 나간다(태운 순번 뒤)
  assert.equal(h.run(event(9, 3, [0, 1])).action, 'replace');
  const msgs = h.decoded();
  assert.deepEqual(msgs.map((m) => [m.type, m.pieceSeq]), [['PIECE', 1], ['PIECE', 4], ['PIECE', 5], ['LEVEL_ARRIVED', undefined]]);
  const { keys, arrived } = collectArrivals(msgs);
  assert.deepEqual(keys, ['9.1.1.-2.0.0', '9.3.1.-2.0.0', '9.3.1.-2.0.1']);
  assert.deepEqual(arrived, [{ segmentId: 9, level: 3, keys: ['9.3.1.-2.0.0', '9.3.1.-2.0.1'] }]);
  const sel = selectDrawable(keys, arrived);
  assert.deepEqual(sel, { draw: ['9.3.1.-2.0.0', '9.3.1.-2.0.1'], pending: [], discard: ['9.1.1.-2.0.0'] });
  // 이 경우(LEVEL_ARRIVED 가 쓰이지 않음) 어댑터가 abandoned 로 알린 key 중 선에 나간 것은 모두 discard 다. 클라이언트의
  // 해제 근거는 이 discard 이고 어댑터 알림이 아니다(F-235, index.mjs ④ 해제 근거).
  const abandoned = h.released.flatMap((x) => x.keys.map(pieceKeyToString));
  for (const k of keys) if (abandoned.includes(k)) assert.ok(sel.discard.includes(k), k);
  // 뒤 수준 전: 태운 조각은 도착 수준이 없어 pending(그리지 않음)
  const before = collectArrivals(msgs.slice(0, 1));
  assert.deepEqual(selectDrawable(before.keys, before.arrived), { draw: [], pending: ['9.1.1.-2.0.0'], discard: [] });
});

test('abandoned 섞인 재시도(어댑터 교체, F-219 ④): 같은 수준의 창 밖 key 는 discard', () => {
  // 옛 어댑터: 수준 1 조각 3 개 중 셋째 PIECE 에서 영구 실패 → 선에는 P1(c0), P2(c1)
  const a = harness();
  assert.throws(() => a.run(event(9, 1, [0, 1, 2]), { call: 3, where: 'before' }), /송출 실패/);
  const u = a.adapter.unfinishedEvent();
  assert.deepEqual(u, { segmentId: 9, level: 1, firstPieceSeq: 1, pieceCount: 3 });
  // 새 어댑터(새 기계): 첫 pieceSeq = 1 + 3. 코어가 다시 낸 수준 1 은 조각 c1, c2
  const b = harness({ firstPieceSeq: u.firstPieceSeq + u.pieceCount });
  assert.equal(b.run(event(9, 1, [1, 2])).action, 'first');
  const msgs = [...a.decoded(), ...b.decoded()];
  assert.deepEqual(msgs.map((m) => [m.type, m.pieceSeq]), [['PIECE', 1], ['PIECE', 2], ['PIECE', 4], ['PIECE', 5], ['LEVEL_ARRIVED', undefined]]);
  const { keys, arrived } = collectArrivals(msgs);
  assert.deepEqual(keys, ['9.1.1.-2.0.0', '9.1.1.-2.0.1', '9.1.1.-2.0.2']);
  assert.deepEqual(arrived, [{ segmentId: 9, level: 1, keys: ['9.1.1.-2.0.1', '9.1.1.-2.0.2'] }]);
  assert.deepEqual(selectDrawable(keys, arrived), { draw: ['9.1.1.-2.0.1', '9.1.1.-2.0.2'], pending: [], discard: ['9.1.1.-2.0.0'] });
});

test('재시도 skip(F-235): LEVEL_ARRIVED 가 쓰였으면 완료, 안 쓰였으면 아님', () => {
  // 'before' call 2: 선에 P1 만 → 완료 표시 없음. 'after' call 3: 선에 P1 P2 LA → 완료 표시 있음(받는 쪽은 선만 본다).
  for (const [f, wire, draw, pending, abandoned] of [
    [{ call: 2, where: 'before' }, [['PIECE', 1]], [], ['9.1.1.-2.0.0'], ['9.1.1.-2.0.0', '9.1.1.-2.0.1']],
    [{ call: 3, where: 'after' }, [['PIECE', 1], ['PIECE', 2], ['LEVEL_ARRIVED', undefined]], ['9.1.1.-2.0.0', '9.1.1.-2.0.1'], [], []],
  ]) {
    const machine = createLevelMachine();
    const h = harness({ machine });
    assert.throws(() => h.run(event(9, 1, [0, 1]), f), /송출 실패/);
    machine.arrive(9, 3, event(9, 3, [0]).pieces); // 다른 경로로 더 높은 수준 확정(선에는 없음)
    const r = h.run(event(9, 1, [0, 1]));
    assert.equal(r.action, 'skip', f.where);
    const msgs = h.decoded();
    assert.deepEqual(msgs.map((m) => [m.type, m.pieceSeq]), wire, f.where);
    const { keys, arrived } = collectArrivals(msgs);
    const sel = selectDrawable(keys, arrived);
    assert.deepEqual(sel, { draw, pending, discard: [] }, f.where);
    // 어댑터가 알린 abandoned 는 고정 배열이다: 'before'(LEVEL_ARRIVED 안 쓰임)는 두 key 전부, 'after'(쓰임)는 빈 배열(F-235).
    assert.deepEqual((r.abandoned ?? []).map(pieceKeyToString), abandoned, f.where);
  }
});

test('빈 keys 항목은 던진다: 변환 결과의 keys 를 비우면 selectDrawable 이 거부', () => {
  const h = harness();
  h.run(event(7, 0, [0]));
  const { keys, arrived } = collectArrivals(h.decoded());
  assert.deepEqual(selectDrawable(keys, arrived).draw, ['7.0.1.-2.0.0']);
  assert.throws(() => selectDrawable(keys, [{ ...arrived[0], keys: [] }]), isPiece);
  assert.throws(() => selectDrawable(keys, [{ segmentId: 7, level: 0 }]), isPiece);
  // 복호한 LEVEL_ARRIVED 를 그대로 넘기는 것(keys 없음)도 거부한다
  assert.throws(() => selectDrawable(keys, [h.decoded()[1]]), isPiece);
});

test('이상 입력은 ClientRasterError(piece)', () => {
  const P = (pieceSeq, segmentId, level, chunkIndex) => ({ type: 'PIECE', pieceSeq, key: { segmentId, level, lod: 0, chunkIndex, tileX: 0, tileY: 0 }, chunk: Uint8Array.of(1) });
  const LA = (segmentId, level, pieceCount) => ({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount });
  // 기준(통과): P1 P2 → LA n=2
  assert.deepEqual(completedKeys([P(1, 7, 0, 0), P(2, 7, 0, 1)], LA(7, 0, 2)), ['7.0.0.0.0.0', '7.0.0.0.0.1']);
  // 창이 최대 pieceSeq 에서 끝난다: 앞의 같은 수준 조각은 창 밖
  assert.deepEqual(completedKeys([P(1, 7, 0, 0), P(3, 7, 0, 1), P(4, 7, 0, 2)], LA(7, 0, 2)), ['7.0.0.0.0.1', '7.0.0.0.0.2']);
  for (const [name, f, re] of [
    ['pieceCount 가 받은 조각보다 많음', () => completedKeys([P(1, 7, 0, 0), P(2, 7, 0, 1)], LA(7, 0, 3)), /pieceCount 3 만큼 조각을 받지 못함\(받은 조각 2\)/],
    ['창에 빈칸(태운 순번)', () => completedKeys([P(1, 7, 0, 0), P(3, 7, 0, 1)], LA(7, 0, 2)), /pieceSeq 2 조각을 받지 못함\(창 2\.\.3\)/],
    ['다른 수준 섞임', () => completedKeys([P(1, 7, 1, 0), P(2, 7, 0, 1)], LA(7, 0, 2)), /창 1\.\.2 에 다른 구간·수준 조각이 섞임: pieceSeq 1 7\.1\.0\.0\.0\.0/],
    ['다른 구간 섞임', () => completedKeys([P(1, 8, 0, 0), P(2, 7, 0, 1)], LA(7, 0, 2)), /창 1\.\.2 에 다른 구간·수준 조각이 섞임: pieceSeq 1 8\.0\.0\.0\.0\.0/],
    ['창 끝이 다른 수준(뒤 이벤트 조각이 앞섬)', () => completedKeys([P(1, 7, 0, 0), P(2, 7, 1, 0)], LA(7, 0, 1)), /창 2\.\.2 에 다른 구간·수준 조각이 섞임: pieceSeq 2 7\.1\.0\.0\.0\.0/],
    ['같은 pieceSeq 에 다른 key', () => completedKeys([P(1, 7, 0, 0), P(1, 7, 0, 1)], LA(7, 0, 1)), /pieceSeq 1 가 두 key 에 쓰임/],
    ['창 안 같은 key 두 번', () => completedKeys([P(1, 7, 0, 0), P(2, 7, 0, 0)], LA(7, 0, 2)), /창에 같은 key 가 두 번: 7\.0\.0\.0\.0\.0/],
    ['조각 없음', () => completedKeys([], LA(7, 0, 1)), /pieceCount 1 만큼 조각을 받지 못함\(받은 조각 0\)/],
    ['pieceCount 0', () => completedKeys([P(1, 7, 0, 0)], LA(7, 0, 0)), /pieceCount 는 1 이상 u32 여야 함: 0/],
    ['segmentId 상한(2^30)', () => completedKeys([P(1, 7, 0, 0)], LA(1073741824, 0, 1)), /LEVEL_ARRIVED segmentId 가 범위 밖/],
    ['PIECE key segmentId 상한(2^30)', () => completedKeys([P(1, 1073741824, 0, 0)], LA(7, 0, 1)), /segmentId/],
    ['level 4', () => completedKeys([P(1, 7, 0, 0)], LA(7, 4, 1)), /LEVEL_ARRIVED level 범위 밖: 4/],
    ['pieceSeq 0', () => completedKeys([P(0, 7, 0, 0)], LA(7, 0, 1)), /pieceSeq 범위 밖: 0/],
    ['LEVEL_ARRIVED 아님', () => completedKeys([P(1, 7, 0, 0)], { type: 'MISSING', segmentId: 7 }), /LEVEL_ARRIVED 메시지가 아님/],
    ['pieces 배열 아님', () => completedKeys(null, LA(7, 0, 1)), /pieces 는 배열이어야 함/],
    ['messages type 없음', () => collectArrivals([{ pieceSeq: 1 }]), /메시지 type 이 없음/],
    ['collectArrivals 에서 모자람', () => collectArrivals([P(1, 7, 0, 0), LA(7, 0, 2)]), /pieceCount 2 만큼 조각을 받지 못함\(받은 조각 1\)/],
  ]) assert.throws(f, (e) => isPiece(e) && re.test(e.message), name);
  // collectArrivals 는 LEVEL_ARRIVED 시점까지의 PIECE 만 본다(뒤 PIECE 로 앞 창을 채우지 않는다)
  assert.throws(() => collectArrivals([P(1, 7, 0, 0), LA(7, 0, 2), P(2, 7, 0, 1)]), isPiece);
  // 다른 종류는 건너뛴다
  assert.deepEqual(collectArrivals([{ type: 'MISSING', segmentId: 3 }, P(1, 7, 0, 0), LA(7, 0, 1)]).arrived, [{ segmentId: 7, level: 0, keys: ['7.0.0.0.0.0'] }]);
});

test('firstPieceSeq 명시 창(F-236): 단독 재전송·maxSeq 와 다른 창·범위 밖 값', () => {
  const P = (pieceSeq, chunkIndex) => ({ type: 'PIECE', pieceSeq, key: { segmentId: 7, level: 0, lod: 0, chunkIndex, tileX: 0, tileY: 0 }, chunk: Uint8Array.of(1) });
  const LA = (pieceCount, firstPieceSeq) => ({ type: 'LEVEL_ARRIVED', segmentId: 7, level: 0, pieceCount, firstPieceSeq });
  const pieces = [P(1, 0), P(2, 1), P(3, 2), P(4, 3), P(5, 4)];
  // firstPieceSeq ≠ maxSeq−n+1: maxSeq 5, n 2 면 옛 규칙은 4..5, 명시 창은 2..3
  assert.deepEqual(completedKeys(pieces, LA(2, 2)), ['7.0.0.0.0.1', '7.0.0.0.0.2']);
  // 단독 재전송: 뒤 PIECE 가 이미 와 있어도 이어받기 뒤 혼자 온 LEVEL_ARRIVED 는 자기 창(1..2)을 가리킨다
  assert.deepEqual(completedKeys(pieces, LA(2, 1)), ['7.0.0.0.0.0', '7.0.0.0.0.1']);
  assert.deepEqual(collectArrivals([...pieces, LA(2, 1), LA(2, 1)]).arrived, [
    { segmentId: 7, level: 0, keys: ['7.0.0.0.0.0', '7.0.0.0.0.1'] }, { segmentId: 7, level: 0, keys: ['7.0.0.0.0.0', '7.0.0.0.0.1'] },
  ]);
  // 창 끝은 firstPieceSeq+n−1(포함): 마지막 PIECE 가 창의 끝이면 통과, 한 칸 모자라면 거부
  assert.deepEqual(completedKeys(pieces, LA(2, 4)), ['7.0.0.0.0.3', '7.0.0.0.0.4']);
  assert.throws(() => completedKeys(pieces, LA(2, 5)), (e) => isPiece(e) && /pieceSeq 6 조각을 받지 못함\(창 5\.\.6\)/.test(e.message));
  // 범위 밖
  const range = /firstPieceSeq 는 1 이상이고 창 끝이 u32 안이어야 함/;
  for (const [first, n] of [[0, 1], [1.5, 1], [0xffffffff, 2]]) {
    assert.throws(() => completedKeys(pieces, LA(n, first)), (e) => isPiece(e) && range.test(e.message), `${first},${n}`);
  }
  assert.throws(() => collectArrivals([...pieces, LA(2, 0)]), (e) => isPiece(e) && range.test(e.message));
});

test('새 세션(F-234): WELCOME resumed=false 가 PIECE 뒤에 오면 거부, 처음 보는 pieceSeq 가 줄면 거부', () => {
  const P = (pieceSeq, segmentId, level, chunkIndex) => ({ type: 'PIECE', pieceSeq, key: { segmentId, level, lod: 0, chunkIndex, tileX: 0, tileY: 0 }, chunk: Uint8Array.of(1) });
  const LA = (segmentId, level, pieceCount) => ({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount });
  const W = (sessionId, resumed, nextPieceSeq) => ({ type: 'WELCOME', sessionId, resumed, nextPieceSeq });
  // 감독 재현 입력: 예전에는 arrived [{9,1,['9.1.0.0.0.1']}] → draw ['9.1.0.0.0.1'] 이었다. 이제 던진다.
  const input = [P(1, 9, 1, 0), P(2, 9, 1, 1), W(77, false, 1), P(1, 9, 1, 0), LA(9, 1, 1)];
  let out = null;
  try { out = collectArrivals(input); } catch (e) { assert.ok(isPiece(e) && /WELCOME resumed=false/.test(e.message), String(e)); }
  assert.equal(out, null, 'collectArrivals 가 던져야 한다');
  // 같은 입력에서 둘째 세션의 P1 은 첫 세션 P1 과 순번·key 가 같아 재전송과 구별되지 않는다. 그래서 WELCOME 검사가 필요하다.
  // 단조 검사(규칙 ①): 같은 순번에 다른 key 는 '두 key', 처음 보는 순번이 가장 큰 순번 이하면 거부.
  assert.throws(() => collectArrivals([P(1, 9, 1, 0), P(2, 9, 1, 1), P(1, 9, 1, 1)]), isPiece);
  assert.throws(() => collectArrivals([P(1, 9, 1, 0), P(3, 9, 1, 1), P(2, 9, 1, 2), LA(9, 1, 2)]), isPiece);
  assert.throws(() => completedKeys([P(1, 9, 1, 0), P(3, 9, 1, 1), P(2, 9, 1, 2)], LA(9, 1, 2)), isPiece);
  assert.throws(() => completedKeys([P(2, 9, 1, 0), P(1, 9, 1, 1)], LA(9, 1, 1)), isPiece);
  // 새 세션은 새 입력: WELCOME 뒤 수신만 넣으면 '9.1.0.0.0.0' 만 그린다
  const fresh = collectArrivals([W(77, false, 1), P(1, 9, 1, 0), LA(9, 1, 1)]);
  assert.deepEqual(fresh, { keys: ['9.1.0.0.0.0'], arrived: [{ segmentId: 9, level: 1, keys: ['9.1.0.0.0.0'] }] });
  assert.deepEqual(selectDrawable(fresh.keys, fresh.arrived), { draw: ['9.1.0.0.0.0'], pending: [], discard: [] });
  // 이어받기(resumed=true, 같은 sessionId): 이력을 잇는다. 재전송(같은 순번·key)은 한 조각, 새 순번은 더 크다.
  const resumed = collectArrivals([W(77, false, 1), P(1, 9, 1, 0), P(2, 9, 1, 1), W(77, true, 3), P(2, 9, 1, 1), P(3, 9, 1, 2), LA(9, 1, 3)]);
  assert.deepEqual(resumed.keys, ['9.1.0.0.0.0', '9.1.0.0.0.1', '9.1.0.0.0.2']);
  assert.deepEqual(resumed.arrived, [{ segmentId: 9, level: 1, keys: ['9.1.0.0.0.0', '9.1.0.0.0.1', '9.1.0.0.0.2'] }]);
  // 이어받기라며 sessionId 가 다르면 거부, resumed 가 boolean 이 아니면 거부
  assert.throws(() => collectArrivals([W(77, false, 1), P(1, 9, 1, 0), W(78, true, 2), P(2, 9, 1, 1)]), isPiece);
  assert.throws(() => collectArrivals([W(77, 0, 1)]), isPiece);
  // sessionId 는 u32, 앞 sessionId 없는 resumed=true 는 거부
  for (const bad of [-1, 1.5, 0x100000000, undefined, '7']) {
    assert.throws(() => collectArrivals([W(bad, false, 1)]), (e) => isPiece(e) && /WELCOME sessionId 는 u32 정수여야 함/.test(e.message), String(bad));
  }
  assert.throws(() => collectArrivals([W(77, true, 1), P(1, 9, 1, 0)]), (e) => isPiece(e) && /resumed=true 인데 앞 WELCOME 의 sessionId 가 없음/.test(e.message));
  assert.throws(() => collectArrivals([P(1, 9, 1, 0), W(77, true, 2)]), (e) => isPiece(e) && /resumed=true 인데 앞 WELCOME 의 sessionId 가 없음/.test(e.message));
  assert.throws(() => collectArrivals([W(77, false, 1), P(1, 9, 1, 0), W(78, true, 2)]), (e) => isPiece(e) && /sessionId 78 가 앞 세션 77 와 다름/.test(e.message));
  assert.equal(collectArrivals([W(0xffffffff, false, 1), W(0xffffffff, true, 1)]).keys.length, 0);
  // 첫 PIECE 앞의 resumed=false 는 통과(여러 번이어도)
  assert.deepEqual(collectArrivals([W(5, false, 1), W(6, false, 1), P(1, 9, 1, 0), LA(9, 1, 1)]).arrived, [{ segmentId: 9, level: 1, keys: ['9.1.0.0.0.0'] }]);
  // 선을 거친 WELCOME 도 같다
  const wire = [encodeMessage(P(1, 9, 1, 0)), encodeMessage(W(77, false, 1)), encodeMessage(P(1, 9, 1, 0))].map((b) => decodeMessage(b));
  assert.equal(wire[1].resumed, false);
  assert.throws(() => collectArrivals(wire), isPiece);
});

test('LEVEL_ARRIVED segmentId -0 은 거부(F-237 ①, selectDrawable 과 같음), 0 은 통과', () => {
  const P0 = { type: 'PIECE', pieceSeq: 1, key: { segmentId: 0, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 }, chunk: Uint8Array.of(1) };
  assert.throws(() => collectArrivals([P0, { type: 'LEVEL_ARRIVED', segmentId: -0, level: 0, pieceCount: 1 }]), isPiece);
  assert.throws(() => completedKeys([P0], { segmentId: -0, level: 0, pieceCount: 1 }), isPiece);
  const ok = collectArrivals([P0, { type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 1 }]);
  assert.ok(Object.is(ok.arrived[0].segmentId, 0));
  assert.deepEqual(selectDrawable(ok.keys, ok.arrived).draw, ['0.0.0.0.0.0']);
});
