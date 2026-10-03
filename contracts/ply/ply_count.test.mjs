import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlyHeader } from './index.mjs';

const raw = (lines) => Buffer.from(lines.join('\n') + '\n', 'latin1');
const XYZ = ['property float x', 'property float y', 'property float z'];
const FMT = 'format binary_little_endian 1.0';

test('거부: element vertex 0x10 (16진법)', () => {
  assert.throws(
    () => parsePlyHeader(raw(['ply', FMT, 'element vertex 0x10', ...XYZ, 'end_header'])),
    /element vertex missing/
  );
});

test('거부: element vertex 1e3 (과학 표기법)', () => {
  assert.throws(
    () => parsePlyHeader(raw(['ply', FMT, 'element vertex 1e3', ...XYZ, 'end_header'])),
    /element vertex missing/
  );
});
