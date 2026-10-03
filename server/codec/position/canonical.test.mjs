import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePositionStream } from './index.mjs';
import { CodecError } from '../../../contracts/codec/index.mjs';

const codeOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof CodecError); return e.code; } return null; };
const U = (a) => Uint8Array.from(a);

test('위치 LEB128 비최소 표현 거부: 0 을 [80 00] 로, 1 을 [81 00] 으로 쓰면 stream', () => {
  assert.equal(codeOf(() => decodePositionStream(U([0x80, 0x00]), 1)), 'stream');
  assert.equal(codeOf(() => decodePositionStream(U([0x81, 0x00]), 1)), 'stream');
  assert.equal(codeOf(() => decodePositionStream(U([0xff, 0x80, 0x00]), 1)), 'stream');
  // 두 번째 점의 차분만 비최소여도 거부
  assert.equal(codeOf(() => decodePositionStream(U([0x05, 0x80, 0x00]), 2)), 'stream');
});

test('위치 LEB128 최소 표현은 통과: [00] 키 0, [80 01] 키 128, [7f] 키 127', () => {
  const a = decodePositionStream(U([0x00]), 1);
  assert.deepEqual([a.qe[0], a.qn[0], a.qu[0]], [0, 0, 0]);
  // 키 128 = 비트 7 → 모턴 비트 7 은 축 (7 % 3 = 1 → n 축) 의 비트 2
  const b = decodePositionStream(U([0x80, 0x01]), 1);
  assert.deepEqual([b.qe[0], b.qn[0], b.qu[0]], [0, 4, 0]);
  const c = decodePositionStream(U([0x7f]), 1);
  assert.deepEqual([c.qe[0], c.qn[0], c.qu[0]], [7, 3, 3]);
});

test('위치 LEB128 8 바이트 이어짐은 stream, 잘림도 stream, 키 ≥ 2^48 은 range', () => {
  assert.equal(codeOf(() => decodePositionStream(U([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), 1)), 'stream');
  assert.equal(codeOf(() => decodePositionStream(U([0x80]), 1)), 'stream');
  assert.equal(codeOf(() => decodePositionStream(U([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40]), 1)), 'range');
});
