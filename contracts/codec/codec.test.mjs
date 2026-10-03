import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEC_API, CODEC_SKLC1, COLOR_MODE, BODY_FIXED_BYTES, CodecError, MORTON_BITS, pointMultiset, ENTROPY_MODE, streamRawBounds } from './index.mjs';

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

test('pointMultiset: 순서와 무관, 각 8개 평면이 다르면 다름', () => {
  const base = { pos_e: Uint16Array.from([1, 2, 3]), pos_n: new Uint16Array(3), pos_u: new Uint16Array(3),
    color_r: new Uint8Array(3), color_g: new Uint8Array(3), color_b: new Uint8Array(3),
    normal_oct_x: new Int8Array(3), normal_oct_y: new Int8Array(3) };
  const mk = (o) => Object.assign(Object.assign({}, base), o);
  // 순서 무관
  const reordered = { ...base, pos_e: Uint16Array.from([3, 1, 2]) };
  assert.deepEqual(pointMultiset(base), pointMultiset(reordered));
  // 각 평면별로 값이 다르면 다름
  const change_pos_e = mk({ pos_e: Uint16Array.from([1, 2, 4]) });
  assert.notDeepEqual(pointMultiset(base), pointMultiset(change_pos_e));
  const change_pos_n = mk({ pos_n: Uint16Array.from([1, 0, 0]) });
  assert.notDeepEqual(pointMultiset(base), pointMultiset(change_pos_n));
  const change_pos_u = mk({ pos_u: Uint16Array.from([0, 1, 0]) });
  assert.notDeepEqual(pointMultiset(base), pointMultiset(change_pos_u));
  const change_color_r = mk({ color_r: Uint8Array.from([1, 0, 0]) });
  assert.notDeepEqual(pointMultiset(base), pointMultiset(change_color_r));
  const change_color_g = mk({ color_g: Uint8Array.from([0, 1, 0]) });
  assert.notDeepEqual(pointMultiset(base), pointMultiset(change_color_g));
  const change_color_b = mk({ color_b: Uint8Array.from([0, 0, 1]) });
  assert.notDeepEqual(pointMultiset(base), pointMultiset(change_color_b));
  const change_normal_x = mk({ normal_oct_x: Int8Array.from([1, 0, 0]) });
  assert.notDeepEqual(pointMultiset(base), pointMultiset(change_normal_x));
  const change_normal_y = mk({ normal_oct_y: Int8Array.from([0, 1, 0]) });
  assert.notDeepEqual(pointMultiset(base), pointMultiset(change_normal_y));
});

test('streamRawBounds: n에 따른 스트림 원바이트 범위(서버·클라이언트 공통)', () => {
  // n=10: pos [10,70], normal [20,60], color [15,800]
  const b10 = streamRawBounds(10);
  assert.deepEqual(b10.pos, [10, 70]);
  assert.deepEqual(b10.normal, [20, 60]);
  assert.deepEqual(b10.color, [15, 800]);
  // n=1: color [min(1+5, 3*1+1)=4, 3*1+770=773]
  const b1 = streamRawBounds(1);
  assert.deepEqual(b1.pos, [1, 7]);
  assert.deepEqual(b1.normal, [2, 6]);
  assert.deepEqual(b1.color, [4, 773]);
  // 큰 n: 선형 스케일
  const b1m = streamRawBounds(1_000_000);
  assert.deepEqual(b1m.pos, [1_000_000, 7_000_000]);
  assert.deepEqual(b1m.normal, [2_000_000, 6_000_000]);
  assert.ok(b1m.color[0] === 1_000_005); // min(1M+5, 3M+1) = 1M+5
  assert.deepEqual(b1m.color[1], 3_000_770);
});
