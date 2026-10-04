// F-277 ④: sentKeys 정리 의미와 평탄성. 정리 비용이 미결 수·앞쪽 삭제 구멍에 따라 늘지 않아야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingEmit, SeqFloorError } from './emit.mjs';
import { measure, median } from '../../../bench/emit_sentkeys_bench.mjs';

const store = () => ({ recordSent: () => true, recordLevelArrived: () => true });
const key = (c) => ({ segmentId: 1, level: 0, lod: 0, chunkIndex: c, tileX: 0, tileY: 0 });
const mk = (floor) => createRecordingEmit({ store: store(), sessionId: 1, send() {}, encode: () => new Uint8Array(1), minPieceSeq: () => floor.v });
const piece = (emit, seq, c = seq) => emit({ type: 'PIECE', key: key(c), pieceSeq: seq, chunk: null });
const la = (emit, first, count) => emit({ type: 'LEVEL_ARRIVED', segmentId: 1, level: 0, firstPieceSeq: first, pieceCount: count });
const retryable = (emit, seq, floor, c = seq) => { floor.v = seq + 1; try { piece(emit, seq, c); return true; } catch (e) { if (e instanceof SeqFloorError) return false; throw e; } };

test('LA 는 창 끝 이하 순번만 지우고 그 위는 남긴다(재시도 판별이 유지된다)', () => {
  const floor = { v: 0 };
  const emit = mk(floor);
  for (let s = 1; s <= 10; s++) piece(emit, s);
  la(emit, 1, 4); // 1..4 정리
  assert.equal(retryable(emit, 3, floor), false); // 정리됨 -> 하한 미만 새 key 로 거부
  assert.equal(retryable(emit, 4, floor), false);
  assert.equal(retryable(emit, 5, floor), true); // 남음 -> 같은 (seq,key) 재시도 통과
  assert.equal(retryable(emit, 10, floor), true);
  assert.equal(retryable(emit, 6, floor, 99), false); // 같은 seq, 다른 key 는 거부
});

test('창이 순번 중간에서 시작해도(앞쪽 순번 남김) 큐가 어긋나지 않는다, 재시도 set 은 자리를 유지한다', () => {
  const floor = { v: 0 };
  const emit = mk(floor);
  for (let s = 1; s <= 6; s++) piece(emit, s);
  piece(emit, 2); // 재시도: 같은 key 다시
  assert.equal(emit._tracked().length, 6); // 자리 유지(덮어쓰기): 끼워 넣으면 7
  la(emit, 3, 2); // 끝 4: 1..4 모두 정리(앞쪽 1,2 포함: 하한 의미는 '끝 이하 전부')
  assert.equal(retryable(emit, 2, floor), false);
  assert.equal(retryable(emit, 5, floor), true);
  la(emit, 5, 2);
  assert.equal(retryable(emit, 6, floor), false);
});

test('많이 쌓였다 비운 뒤(큐 압축 경로) 다시 써도 같은 의미', () => {
  const floor = { v: 0 };
  const emit = mk(floor);
  for (let s = 1; s <= 5000; s++) piece(emit, s);
  for (let f = 1; f <= 4000; f += 4) la(emit, f, 4); // 압축 여러 번
  assert.equal(retryable(emit, 4000, floor), false);
  assert.equal(retryable(emit, 4001, floor), true);
  const t = emit._tracked();
  assert.ok(t.length <= 2 * t.live + 1024, `압축 안 됨: length ${t.length}, live ${t.live}`);
  la(emit, 4001, 1000); // 전부 비움
  assert.deepEqual(emit._tracked(), { live: 0, length: 0 });
  assert.equal(retryable(emit, 5000, floor), false);
  for (let s = 5001; s <= 5003; s++) piece(emit, s);
  assert.equal(retryable(emit, 5002, floor), true);
});

test('PIECE 입구: 정수 아닌 pieceSeq 는 TypeError, 기록·송출 없음', () => {
  let sends = 0;
  let records = 0;
  const emit = createRecordingEmit({ store: { recordSent: () => { records++; return true; }, recordLevelArrived: () => true }, sessionId: 1, send() { sends++; }, encode: () => new Uint8Array(1), minPieceSeq: () => 0 });
  for (const bad of [NaN, 1.5, undefined]) {
    assert.throws(() => piece(emit, bad, 1), TypeError);
  }
  assert.equal(sends, 0);
  assert.equal(records, 0);
});

test('정리된 seq 를 재기록한 뒤 더 큰 창 LA 가 오면 그 seq 도 지워 하한 미만 재시도를 거부한다', () => {
  const floor = { v: 0 };
  const emit = mk(floor);
  for (let s = 1; s <= 6; s++) piece(emit, s);
  la(emit, 1, 2); // 1..2 정리
  piece(emit, 2); // 하한 0: 정리된 seq 재기록
  la(emit, 3, 2); // 끝 4: 재기록된 2 도 지운다
  floor.v = 5;
  assert.throws(() => piece(emit, 2), SeqFloorError);
});

test('평탄성: 60000 개 쌓인 뒤 오래된 창부터 끝나는 흐름의 LA 당 시간이 첫 LA 에서 큐가 비는 새 창 흐름의 2배 이내(중앙값)', () => {
  const N = 60000;
  const ratios = [];
  for (let i = 0; i < 3; i++) {
    const o = measure(createRecordingEmit, 'old', N, 20000);
    const n = measure(createRecordingEmit, 'new', N, 20000);
    ratios.push(o / n);
  }
  assert.ok(median(ratios) < 2, `old/new 중앙값 ${median(ratios).toFixed(2)} (${ratios.map((r) => r.toFixed(2)).join(', ')})`);
});
