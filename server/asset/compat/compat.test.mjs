import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkCompat } from './index.mjs';
import { OFFSETS } from '../../../contracts/asset/index.mjs';

const dir = new URL('../../../fixtures/asset_golden/', import.meta.url);
const golden = (n) => new Uint8Array(readFileSync(new URL(n, dir)));

// 골든 복사본의 헤더 필드를 바꾼다(u16 은 little-endian).
function mutate(base, { major, minor, headerSize, codec, format, magic } = {}) {
  const b = new Uint8Array(base);
  const dv = new DataView(b.buffer);
  if (major !== undefined) dv.setUint16(OFFSETS.versionMajor, major, true);
  if (minor !== undefined) dv.setUint16(OFFSETS.versionMinor, minor, true);
  if (headerSize !== undefined) dv.setUint16(OFFSETS.headerSize, headerSize, true);
  if (codec !== undefined) b[OFFSETS.codec] = codec;
  if (format !== undefined) b[OFFSETS.format] = format;
  if (magic !== undefined) b.set(magic, 0);
  return b;
}

// 헤더를 headerSize 로 늘린 파일. 확장 영역은 0xAB, 본문은 뒤로 민다.
function withExtension(base, headerSize, fields) {
  const out = new Uint8Array(headerSize + base.length - 128);
  out.set(base.subarray(0, 128), 0);
  out.fill(0xab, 128, headerSize);
  out.set(base.subarray(128), headerSize);
  return mutate(out, { headerSize, ...fields });
}

for (const name of ['point27.skla', 'gauss56.skla']) {
  const base = golden(name);

  test(`compat_matrix ${name}`, () => {
    const reservedDirty = mutate(base, { minor: 7 });
    reservedDirty.fill(0x5a, OFFSETS.reserved, OFFSETS.reserved + 12);
    const rows = [
      ['major 0', mutate(base, { major: 0 }), undefined, 'reject'],
      ['major 2', mutate(base, { major: 2 }), undefined, 'reject'],
      ['major 65535', mutate(base, { major: 65535 }), undefined, 'reject'],
      ['1.0', base, undefined, 'accept'],
      ['1.1', mutate(base, { minor: 1 }), undefined, 'accept_ignore_extension'],
      ['1.7', mutate(base, { minor: 7 }), undefined, 'accept_ignore_extension'],
      ['1.7 header 192', withExtension(base, 192, { minor: 7 }), undefined, 'accept_ignore_extension'],
      ['1.7 reserved nonzero', reservedDirty, undefined, 'accept_ignore_extension'],
      ['reader 3, file 1.3', mutate(base, { minor: 3 }), { readerMinor: 3 }, 'accept'],
      ['reader 3, file 1.4', mutate(base, { minor: 4 }), { readerMinor: 3 }, 'accept_ignore_extension'],
      ['reader 3, file 1.0', base, { readerMinor: 3 }, 'accept'],
      ['unknown codec 1', mutate(base, { codec: 1 }), undefined, 'reject'],
      ['unknown codec 255, minor 9', mutate(base, { codec: 255, minor: 9 }), undefined, 'reject'],
      ['unknown codec 2, reader 9', mutate(base, { codec: 2, minor: 5 }), { readerMinor: 9 }, 'reject'],
      ['unknown format 0', mutate(base, { format: 0 }), undefined, 'reject'],
      ['bad magic', mutate(base, { magic: [0x53, 0x4b, 0x4c, 0x42] }), undefined, 'reject'],
      ['127 bytes', base.subarray(0, 127), undefined, 'reject'],
      ['empty', new Uint8Array(0), undefined, 'reject'],
      ['header_size 124', mutate(base, { headerSize: 124 }), undefined, 'reject'],
      ['header_size 130', mutate(base, { headerSize: 130 }), undefined, 'reject'],
      ['header_size beyond input', mutate(base, { headerSize: 65532, minor: 1 }), undefined, 'reject'],
    ];
    for (const [label, bytes, opts, action] of rows) {
      const r = checkCompat(bytes, opts);
      assert.equal(r.action, action, label);
      assert.equal(typeof r.reason, 'string', label);
      assert.ok(r.reason.length > 0, `${label}: reason empty`);
    }
  });
}

test('compat accepts a view with nonzero byteOffset', () => {
  const base = golden('point27.skla');
  const padded = new Uint8Array(base.length + 5);
  padded.set(base, 5);
  assert.equal(checkCompat(padded.subarray(5)).action, 'accept');
});

test('compat: required planes keep their values with a body extension plane (1.5)', () => {
  const base = golden('point27.skla');
  assert.equal(base.length, 480);
  // 본문 끝에 확장 평면 64 B 를 붙이고 부 버전 5, body_bytes 352 → 416 으로 올린다.
  const big = new Uint8Array(480 + 64);
  big.set(base, 0);
  big.fill(0xee, 480);
  const dv = new DataView(big.buffer);
  dv.setUint16(OFFSETS.versionMinor, 5, true);
  dv.setUint32(OFFSETS.bodyBytes, 416, true);
  assert.equal(checkCompat(big).action, 'accept_ignore_extension');

  // 필수 평면 오프셋(헤더 128 뒤): pos_e 0, pos_n 64, pos_u 128, color_r 192, color_g 224, color_b 256, oct_x 288, oct_y 320
  const u16 = (o) => dv.getUint16(128 + o, true);
  const u8 = (o) => dv.getUint8(128 + o);
  const i8 = (o) => dv.getInt8(128 + o);
  // 첫 점
  assert.deepEqual([u16(0), u16(64), u16(128)], [0, 0, 0]);
  assert.deepEqual([u8(192), u8(224), u8(256)], [0, 255, 0]);
  assert.deepEqual([i8(288), i8(320)], [0, 0]);
  // 마지막 점(31)
  assert.deepEqual([u16(2 * 31), u16(64 + 2 * 31), u16(128 + 2 * 31)], [3584, 2304, 1984]);
  assert.deepEqual([u8(192 + 31), u8(224 + 31), u8(256 + 31)], [248, 7, 123]);
  assert.deepEqual([i8(288 + 31), i8(320 + 31)], [28, 37]);
  // 확장 평면은 필수 평면 영역을 건드리지 않는다
  assert.equal(u8(352), 0xee);
});
