import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEC_API, CODEC_SKLC1, COLOR_MODE, BODY_FIXED_BYTES, CodecError, MORTON_BITS, pointMultiset, ENTROPY_MODE } from './index.mjs';

test('CODEC_API 는 T09.1~T09.11 을 가리키고 소유 경로가 서로 다르다', () => {
  assert.equal(Object.keys(CODEC_API).length, 11);
  const mods = Object.values(CODEC_API).map((v) => v.module);
  assert.equal(new Set(mods).size, 11);
  for (const m of mods) assert.match(m, /^(server\/codec|client\/codec|bench\/codec)/);
});

test('상수: codec 1, 색 모드 0/1/2, 본문 고정부 16, 모턴 48 비트, 엔트로피 모드 0/1', () => {
  assert.equal(CODEC_SKLC1, 1);
  assert.deepEqual({ ...COLOR_MODE }, { DELTA: 0, QUANT2: 1, PALETTE: 2 });
  assert.equal(BODY_FIXED_BYTES, 4 + 12);
  assert.equal(MORTON_BITS, 48);
  assert.deepEqual({ ...ENTROPY_MODE }, { STORED: 0, RANGE: 1 });
});

test('CodecError 는 code 와 codec: 접두를 가진다', () => {
  const e = new CodecError('stream', 'x');
  assert.equal(e.code, 'stream');
  assert.match(e.message, /^codec: /);
});

test('pointMultiset: 순서와 무관, 값이 다르면 다름', () => {
  const mk = (e) => ({ pos_e: Uint16Array.from(e), pos_n: new Uint16Array(e.length), pos_u: new Uint16Array(e.length),
    color_r: new Uint8Array(e.length), color_g: new Uint8Array(e.length), color_b: new Uint8Array(e.length),
    normal_oct_x: new Int8Array(e.length), normal_oct_y: new Int8Array(e.length) });
  assert.deepEqual(pointMultiset(mk([1, 2, 3])), pointMultiset(mk([3, 1, 2])));
  assert.notDeepEqual(pointMultiset(mk([1, 2, 3])), pointMultiset(mk([1, 2, 4])));
});
