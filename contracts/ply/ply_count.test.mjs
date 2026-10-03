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

test('거부: element vertex +5 (부호 있는 양수)', () => {
  assert.throws(
    () => parsePlyHeader(raw(['ply', FMT, 'element vertex +5', ...XYZ, 'end_header'])),
    /element vertex missing/
  );
});

test('거부: element vertex 5.0 (소수점)', () => {
  assert.throws(
    () => parsePlyHeader(raw(['ply', FMT, 'element vertex 5.0', ...XYZ, 'end_header'])),
    /element vertex missing/
  );
});

test('거부: element vertex -1 (음수)', () => {
  assert.throws(
    () => parsePlyHeader(raw(['ply', FMT, 'element vertex -1', ...XYZ, 'end_header'])),
    /element vertex missing/
  );
});

test('거부: element vertex 빈 값', () => {
  assert.throws(
    () => parsePlyHeader(raw(['ply', FMT, 'element vertex', ...XYZ, 'end_header'])),
    /element vertex missing/
  );
});

test('거부: property constructor 타입 (헤더 오류)', () => {
  assert.throws(
    () => parsePlyHeader(raw(['ply', FMT, 'element vertex 5', 'property constructor x', 'property float y', 'property float z', 'end_header'])),
    /unknown type constructor/
  );
});

test('거부: property toString 타입 (헤더 오류)', () => {
  assert.throws(
    () => parsePlyHeader(raw(['ply', FMT, 'element vertex 5', 'property float x', 'property toString y', 'property float z', 'end_header'])),
    /unknown type toString/
  );
});

test('거부: property __proto__ 타입 (헤더 오류)', () => {
  assert.throws(
    () => parsePlyHeader(raw(['ply', FMT, 'element vertex 5', 'property float x', 'property float y', 'property __proto__ z', 'end_header'])),
    /unknown type __proto__/
  );
});
