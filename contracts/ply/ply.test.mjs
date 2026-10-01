import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlyHeader } from './index.mjs';

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
