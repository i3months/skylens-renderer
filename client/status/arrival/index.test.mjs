import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArrivalPlanner } from './index.mjs';
import { encodeMessage } from '../../proto/index.mjs';
// PIECE_REQUEST 는 c2s 라 복호는 서버 codec 이 한다(클라이언트 decodeMessage 는 s2c 만 받는다).
import { decodeMessage } from '../../../server/proto/codec/index.mjs';

const key = (segmentId, chunkIndex, level = 1, lod = 0, tileX = 0, tileY = 0) => ({ segmentId, level, lod, chunkIndex, tileX, tileY });

test('녹화 재생: drain 항목 순서가 도착 순서와 같다 (3+2+4=9)', () => {
  const p = createArrivalPlanner();
  const s0 = [key(0, 0), key(0, 1), key(0, 2)];
  const s1 = [key(1, 0), key(1, 1)];
  const s2 = [key(2, 0), key(2, 1), key(2, 2), key(2, 3)];
  p.onSegmentArrived(0, s0); p.onSegmentArrived(1, s1); p.onSegmentArrived(2, s2);
  assert.equal(p.pendingCount(), 9);
  const out = p.drain();
  assert.equal(out.length, 1);
  assert.equal(out[0].reqId, 0);
  assert.deepEqual(out[0].items, [...s0, ...s1, ...s2]);
});

test('600 개는 256·256·88 로 나뉘고 reqId 0,1,2', () => {
  const p = createArrivalPlanner();
  const ks = Array.from({ length: 600 }, (_, i) => key(5, i));
  p.onSegmentArrived(5, ks);
  const out = p.drain();
  assert.deepEqual(out.map((m) => m.items.length), [256, 256, 88]);
  assert.deepEqual(out.map((m) => m.reqId), [0, 1, 2]);
  assert.deepEqual(out.flatMap((m) => m.items), ks);
  assert.deepEqual(p.drain(), []);
  p.onSegmentArrived(5, [key(5, 600)]);
  assert.equal(p.drain()[0].reqId, 3);
});

test('maxItems 는 256 으로 잘리고 작으면 따른다', () => {
  const a = createArrivalPlanner({ maxItems: 1000 });
  a.onSegmentArrived(0, Array.from({ length: 300 }, (_, i) => key(0, i)));
  assert.deepEqual(a.drain().map((m) => m.items.length), [256, 44]);
  const b = createArrivalPlanner({ maxItems: 4 });
  b.onSegmentArrived(0, Array.from({ length: 10 }, (_, i) => key(0, i)));
  assert.deepEqual(b.drain().map((m) => m.items.length), [4, 4, 2]);
  assert.throws(() => createArrivalPlanner({ maxItems: 0 }), RangeError);
  assert.throws(() => createArrivalPlanner({ maxItems: 1.5 }), TypeError);
});

test('중복 키는 한 번만 (같은 호출 안, 다른 호출, drain 뒤)', () => {
  const p = createArrivalPlanner();
  p.onSegmentArrived(0, [key(0, 0), key(0, 0), key(0, 1)]);
  assert.equal(p.pendingCount(), 2);
  p.onSegmentArrived(0, [key(0, 1), key(0, 2)]);
  assert.equal(p.pendingCount(), 3);
  assert.equal(p.drain()[0].items.length, 3);
  p.onSegmentArrived(0, [key(0, 0), key(0, 1), key(0, 2)]);
  assert.equal(p.pendingCount(), 0);
  assert.deepEqual(p.drain(), []);
  // level 이 다르면 다른 키
  p.onSegmentArrived(0, [key(0, 0, 2)]);
  assert.equal(p.pendingCount(), 1);
});

test('모든 drain 결과가 부호화되고 decode 한 값이 원본과 같다', () => {
  const p = createArrivalPlanner();
  const ks = Array.from({ length: 600 }, (_, i) => key(7, i % 65536, i % 4, i % 8, i - 300, -i));
  ks.push(key(0x3fffffff, 65535, 3, 7, 2147483647, -2147483648));
  p.onSegmentArrived(7, ks);
  const out = p.drain();
  assert.equal(out.length, 3);
  for (const m of out) assert.deepEqual(decodeMessage(encodeMessage(m)), m);
});

test('잘못된 입력은 TypeError/RangeError 이고 pendingCount 불변', () => {
  const p = createArrivalPlanner();
  p.onSegmentArrived(0, [key(0, 0), key(0, 1)]);
  const bad = [
    [() => p.onSegmentArrived(0, 'x'), TypeError],
    [() => p.onSegmentArrived(0, null), TypeError],
    [() => p.onSegmentArrived(0, [key(0, 5), null]), TypeError],
    [() => p.onSegmentArrived(0, [key(0, 5), key(0, 65536)]), RangeError],
    [() => p.onSegmentArrived(0, [key(0, 5), key(0, 0, 4)]), RangeError],
    [() => p.onSegmentArrived(0, [key(0, 5), key(0, 0, 0, 8)]), RangeError],
    [() => p.onSegmentArrived(0, [key(0, 5), key(0, 0, 0, 0, 2147483648)]), RangeError],
    [() => p.onSegmentArrived(0, [key(0, 5), key(0, 0, 0, 0, 0, 1.5)]), TypeError],
    [() => p.onSegmentArrived(0, [key(0x40000000, 0)]), RangeError],
    [() => p.onSegmentArrived(-1, []), RangeError],
    [() => p.onSegmentArrived('0', []), TypeError],
  ];
  for (const [fn, E] of bad) {
    assert.throws(fn, E);
    assert.equal(p.pendingCount(), 2);
  }
  // 던진 호출의 유효 키(0,5)는 기억되지 않아 나중에 정상 요청된다
  p.onSegmentArrived(0, [key(0, 5)]);
  assert.equal(p.pendingCount(), 3);
});

test('drain 은 비운다', () => {
  const p = createArrivalPlanner();
  p.onSegmentArrived(0, [key(0, 0)]);
  assert.equal(p.drain().length, 1);
  assert.equal(p.pendingCount(), 0);
  assert.deepEqual(p.drain(), []);
});
