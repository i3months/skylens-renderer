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
