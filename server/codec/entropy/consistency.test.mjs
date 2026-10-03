import test from 'node:test';
import assert from 'node:assert/strict';
import { entropyEncode, entropyDecode } from './index.mjs';
import { CodecError } from '../../../contracts/codec/index.mjs';

const codeOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof CodecError); return e.code; } return null; };
const U = (a) => Uint8Array.from(a);

test('mode 1 에서 rawLen 이 0 이면 stream (빈 출력으로 통과하던 비정규 컨테이너)', () => {
  assert.equal(codeOf(() => entropyDecode(U([1, 0, 0, 0, 0, 0, 0]))), 'stream');
  // 정규 빈 입력은 [00 00] 이고 그대로 복호된다
  assert.deepEqual(entropyEncode(new Uint8Array(0)), U([0, 0]));
  assert.equal(entropyDecode(U([0, 0])).length, 0);
});

test('mode 1 에서 payload 길이 > rawLen 이면 stream, 경계 payload == rawLen 은 정상 통과', () => {
  // rawLen 1, payload 6 B(5 B 이상이지만 rawLen 보다 큼)
  assert.equal(codeOf(() => entropyDecode(U([1, 1, 0, 0, 0, 0, 0, 0]))), 'stream');
  // 부호기가 만든 mode 1 컨테이너 중 payload == rawLen 인 것은 가드가 막지 않아야 한다
  const raw = new Uint8Array(16); // 0 이 16 개: 실측으로 payload 가 정확히 16 B(= rawLen, 부호기가 mode 1 을 고르는 최소 길이)
  const enc = entropyEncode(raw);
  assert.equal(enc[0], 1);
  const payloadLen = enc.length - 2;
  assert.equal(payloadLen, 16);
  assert.deepEqual(entropyDecode(enc), raw);
  // 정상 mode 1 컨테이너의 rawLen 을 payloadLen - 1 로 줄이면 payload > rawLen 이라 stream
  const bad = enc.slice(); bad[1] = payloadLen - 1;
  assert.equal(codeOf(() => entropyDecode(bad)), 'stream');
});

test('범위 복호 실패는 stream: 모자람·남음·첫 바이트·끝 상태', () => {
  const raw = Uint8Array.from({ length: 300 }, (_, i) => i % 7);
  const enc = entropyEncode(raw);
  assert.equal(enc[0], 1);
  assert.equal(codeOf(() => entropyDecode(enc.slice(0, enc.length - 1))), 'stream');
  assert.equal(codeOf(() => entropyDecode(new Uint8Array([...enc, 0]))), 'stream');
  const first = enc.slice(); first[1 + 2] ^= 1; // rawLen 300 은 LEB 2 B, payload 첫 바이트는 인덱스 3
  assert.equal(codeOf(() => entropyDecode(first)), 'stream');
  const tail = enc.slice(); tail[tail.length - 1] ^= 0x55;
  assert.equal(codeOf(() => entropyDecode(tail)), 'stream');
});

test('entropy LEB128: 비최소 표현은 stream, 8 바이트 이어짐은 limit(rawLen 상한 초과)', () => {
  assert.equal(codeOf(() => entropyDecode(U([0, 0x81, 0x00, 1]))), 'stream');
  assert.equal(codeOf(() => entropyDecode(U([0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]))), 'limit');
});
