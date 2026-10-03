import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlyHeader, PLY_HEADER_MAX_BYTES } from './index.mjs';
import { countCopies } from '../../server/points/test_util/copies.mjs';

const hdr = (n, props = 'property float x\nproperty float y\nproperty float z\n') =>
  Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props}end_header\n`, 'latin1');

test('parses a 3-float header', () => {
  const h = parsePlyHeader(Buffer.concat([hdr(2), Buffer.alloc(24)]));
  assert.equal(h.vertexCount, 2);
  assert.equal(h.stride, 12);
  assert.equal(h.headerBytes, hdr(2).length);
});
test('rejects missing end_header and list properties', () => {
  assert.throws(() => parsePlyHeader(Buffer.from('ply\nformat binary_little_endian 1.0\n')), /end_header/);
  assert.throws(() => parsePlyHeader(hdr(1, 'property list uchar int idx\n')), /list/);
});

const raw = (lines) => Buffer.from(lines.join('\n') + '\n', 'latin1');
const XYZ = ['property float x', 'property float y', 'property float z'];
const FMT = 'format binary_little_endian 1.0';

test('rejects bad magic', () => {
  assert.throws(() => parsePlyHeader(raw(['plx', FMT, 'element vertex 1', ...XYZ, 'end_header'])), /bad magic/);
});
test('rejects non-little-endian and missing format', () => {
  assert.throws(() => parsePlyHeader(raw(['ply', 'format ascii 1.0', 'element vertex 1', ...XYZ, 'end_header'])), /unsupported format ascii/);
  assert.throws(() => parsePlyHeader(raw(['ply', 'format binary_big_endian 1.0', 'element vertex 1', ...XYZ, 'end_header'])), /unsupported format binary_big_endian/);
  assert.throws(() => parsePlyHeader(raw(['ply', 'element vertex 1', ...XYZ, 'end_header'])), /unsupported format null/);
});
test('rejects unknown property type', () => {
  assert.throws(() => parsePlyHeader(hdr(1, 'property float x\nproperty float y\nproperty float z\nproperty quad w\n')), /unknown type quad/);
});
test('rejects missing, negative and non-numeric vertex count; zero vertices without properties', () => {
  assert.throws(() => parsePlyHeader(hdr(0, '')), /no properties/);
  assert.throws(() => parsePlyHeader(hdr(-1)), /element vertex missing/);
  assert.throws(() => parsePlyHeader(raw(['ply', FMT, ...XYZ, 'end_header'])), /element vertex missing/);
  assert.throws(() => parsePlyHeader(hdr('abc')), /element vertex missing/);
  assert.throws(() => parsePlyHeader(hdr(1.5)), /element vertex missing/);
});
test('rejects a vertex element without properties (stride 0) for any count', () => {
  for (const n of [1, 1000000]) {
    assert.throws(() => parsePlyHeader(hdr(n, '')), /no properties/);
  }
  // properties declared on another element do not count
  assert.throws(() => parsePlyHeader(raw(['ply', FMT, 'element vertex 1000000', 'element face 3', 'property float x', 'end_header'])), /no properties/);
  assert.throws(() => parsePlyHeader(raw(['ply', FMT, 'element face 3', ...XYZ, 'element vertex 1000000', 'end_header'])), /no properties/);
});
test('rejects a vertex layout lacking x, y or z', () => {
  assert.throws(() => parsePlyHeader(hdr(10, 'property float x\nproperty float y\n')), /property z missing/);
  assert.throws(() => parsePlyHeader(hdr(10, 'property float y\nproperty float z\n')), /property x missing/);
  assert.throws(() => parsePlyHeader(hdr(10, 'property float x\nproperty float z\nproperty uchar r\n')), /property y missing/);
});
test('accepts extra properties besides x/y/z', () => {
  const h = parsePlyHeader(hdr(1, 'property float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty double w\n'));
  assert.equal(h.stride, 12 + 1 + 8);
});

// 길이가 정확히 total 바이트인 유효 머리(주석 줄로 채운다)
function paddedHeader(total) {
  const pre = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n';
  const post = 'end_header\n';
  const padLen = total - pre.length - post.length - 'comment \n'.length;
  assert.ok(padLen >= 0, `total ${total} too small`);
  const h = Buffer.from(pre + 'comment ' + 'a'.repeat(padLen) + '\n' + post, 'latin1');
  assert.equal(h.length, total);
  return h;
}

test('parsePlyHeader: 상한 값은 1 MiB 로 고정', () => assert.equal(PLY_HEADER_MAX_BYTES, 1048576));

test('parsePlyHeader: 상한(1 MiB) 경계 ±1', () => {
  const LIMIT = 1048576; // 상수를 import 하지 않고 적어 상한 변경을 잡는다
  const body = Buffer.alloc(64, 7);
  const mk = (total) => Buffer.concat([paddedHeader(total), body]);
  // end_header\n 이 정확히 상한 바이트에서 끝나면 성공, 한 바이트 넘으면 실패
  assert.equal(parsePlyHeader(mk(LIMIT - 1)).headerBytes, LIMIT - 1);
  assert.equal(parsePlyHeader(mk(LIMIT)).headerBytes, LIMIT);
  assert.throws(() => parsePlyHeader(mk(LIMIT + 1)), /end_header not found/);
  assert.throws(() => parsePlyHeader(mk(LIMIT + 64)), /end_header not found/);
  // 본문이 없는 입력도 같다
  assert.equal(parsePlyHeader(paddedHeader(LIMIT)).headerBytes, LIMIT);
  assert.throws(() => parsePlyHeader(paddedHeader(LIMIT + 1)), /end_header not found/);
  // 상한 밖에 있는 end_header 는 앞 쓰레기 때문에 못 찾는다(기존 동작)
  const h = hdr(1);
  assert.throws(() => parsePlyHeader(Buffer.concat([Buffer.alloc(LIMIT, 0x20), h])), /end_header not found/);
  assert.equal(parsePlyHeader(h).headerBytes, h.length);
});

test('parsePlyHeader: maxHeaderBytes 인자 경계 ±1', () => {
  const buf = Buffer.concat([hdr(3), Buffer.alloc(100)]);
  const L = hdr(3).length;
  assert.equal(parsePlyHeader(buf, L).headerBytes, L);
  assert.equal(parsePlyHeader(buf, L + 1).headerBytes, L);
  assert.throws(() => parsePlyHeader(buf, L - 1), /end_header not found/);
  assert.throws(() => parsePlyHeader(buf, 0), /end_header not found/);
  // 인자가 상한보다 크면 그 값까지 본다(ref_images 처럼 긴 머리)
  const big = paddedHeader(PLY_HEADER_MAX_BYTES + 100);
  assert.throws(() => parsePlyHeader(big), /end_header not found/);
  assert.equal(parsePlyHeader(big, PLY_HEADER_MAX_BYTES + 100).headerBytes, PLY_HEADER_MAX_BYTES + 100);
  assert.throws(() => parsePlyHeader(big, PLY_HEADER_MAX_BYTES + 99), /end_header not found/);
});

test('parsePlyHeader: 입력을 복사하지 않는다(복사 바이트 직접 계수)', () => {
  const body = Buffer.alloc(8 << 20, 1);
  const buf = Buffer.concat([hdr(1), body]);
  const copied = countCopies(() => { parsePlyHeader(buf); parsePlyHeader(buf.subarray(0, 1 << 20)); parsePlyHeader(buf, 4096); });
  // 헤더 파싱이 만드는 객체는 문자열뿐이다. 본문 크기(8 MiB)나 상한(1 MiB)만큼 복사하면 실패
  assert.ok(copied < 4096, `copied ${copied} B`);
  // 바이트 오프셋이 있는 뷰와 Uint8Array 도 마찬가지
  const view = new Uint8Array(buf.buffer, buf.byteOffset + 0, buf.byteLength);
  assert.ok(countCopies(() => assert.equal(parsePlyHeader(view).vertexCount, 1)) < 4096);
});
