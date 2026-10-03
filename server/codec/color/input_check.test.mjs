import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeColorStream, decodeColorStream } from './index.mjs';
import { CodecError } from '../../../contracts/codec/index.mjs';

const codeOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof CodecError); return e.code; } return null; };

test('Uint8Array 가 아닌 색 입력은 CodecError 로 거부(Uint16Array.of(256) 가 팔레트 0 으로 저장되던 것)', () => {
  const u8 = Uint8Array.of(1);
  assert.equal(codeOf(() => encodeColorStream(Uint16Array.of(256), u8, u8)), 'stream');
  assert.equal(codeOf(() => encodeColorStream(u8, Uint16Array.of(256), u8, { lossy: true })), 'stream');
  assert.equal(codeOf(() => encodeColorStream(u8, u8, [1])), 'stream');
  assert.equal(codeOf(() => encodeColorStream(u8, u8, new Uint8ClampedArray(1))), 'stream');
});

test('길이가 다른 채널은 할당 전에 거부', () => {
  assert.equal(codeOf(() => encodeColorStream(new Uint8Array(3), new Uint8Array(2), new Uint8Array(3), { lossy: true })), 'stream');
});

test('QUANT2 최대 복원값은 254: 입력 252..255 는 모두 254 로 복호(255 상한은 도달 불가)', () => {
  const v = Uint8Array.of(252, 253, 254, 255, 0, 3);
  const d = decodeColorStream(encodeColorStream(v, v, v, { lossy: true }), 6);
  assert.deepEqual([...d.r], [254, 254, 254, 254, 2, 2]);
  assert.deepEqual([...d.b], [254, 254, 254, 254, 2, 2]);
});
