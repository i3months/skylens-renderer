import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import * as asset from './index.mjs';
import {
  parseHeader, serializeHeader, bodyLayout, AssetFormatError, LEVEL_STEPS, HEADER_SIZE, OFFSETS, SOURCE_RECORD_BYTES,
  FORMAT_POINT27, FORMAT_GAUSS56,
} from './index.mjs';
import { GOLDENS } from '../../fixtures/asset_golden/generate.mjs';

const dir = new URL('../../fixtures/asset_golden/', import.meta.url);
const load = (name) => new Uint8Array(readFileSync(new URL(name, dir)));
const sidecar = (name) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const CASES = [
  { file: 'point27.skla', json: 'point27.json' },
  { file: 'gauss56.skla', json: 'gauss56.json' },
];

function readPlaneValue(bytes, headerSize, plane, i) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = headerSize + plane.offset;
  switch (plane.type) {
    case 'u16': return dv.getUint16(base + 2 * i, true);
    case 'u8': return dv.getUint8(base + i);
    case 'i8': return dv.getInt8(base + i);
    case 'u32': return dv.getUint32(base + 4 * i, true);
    default: throw new Error(plane.type);
  }
}

for (const c of CASES) {
  test(`golden ${c.file}: parseHeader fields match the sidecar`, () => {
    const bytes = load(c.file);
    const s = sidecar(c.json);
    const h = parseHeader(bytes);
    assert.equal(bytes.length, s.fileBytes);
    const { segLevelRaw, levelStep, checksumHex, ...expected } = s.header;
    for (const [k, v] of Object.entries(expected)) assert.deepEqual(h[k], v, `field ${k}`);
    assert.equal(new DataView(bytes.buffer).getUint32(OFFSETS.segLevel, true), segLevelRaw);
    assert.equal(LEVEL_STEPS[h.level], levelStep);
    assert.equal(h.checksum.toString(16).padStart(8, '0'), checksumHex);
    assert.equal(h.headerSize + h.bodyBytes, bytes.length);
    assert.deepEqual(h.reserved, new Uint8Array(12));
    assert.equal(h.extension.length, 0);
  });

  test(`golden ${c.file}: body planes, first and last point match the sidecar`, () => {
    const bytes = load(c.file);
    const s = sidecar(c.json);
    const h = parseHeader(bytes);
    const layout = bodyLayout(h.format, h.pointCount);
    assert.equal(layout.requiredBytes, h.bodyBytes);
    assert.deepEqual(layout.planes.map((p) => ({ name: p.name, offset: p.offset })), s.planes);
    for (const pt of [s.firstPoint, s.lastPoint]) {
      for (const p of layout.planes) {
        assert.equal(readPlaneValue(bytes, h.headerSize, p, pt.index), pt.stored[p.name], `point ${pt.index} ${p.name}`);
      }
    }
    // 평면 끝 채움 바이트는 0
    for (const p of layout.planes) {
      for (let o = p.bytes; o < p.paddedBytes; o++) assert.equal(bytes[h.headerSize + p.offset + o], 0, `${p.name} pad ${o}`);
    }
  });

  test(`golden ${c.file}: checksum is CRC-32 over the file with the checksum field zeroed`, () => {
    const bytes = load(c.file);
    const copy = bytes.slice();
    copy.fill(0, OFFSETS.checksum, OFFSETS.checksum + 4);
    assert.equal(crc32(copy), parseHeader(bytes).checksum);
  });

  test(`golden ${c.file}: generator reproduces identical bytes`, () => {
    assert.deepEqual(GOLDENS[c.file](), load(c.file));
  });

  test(`golden ${c.file}: serializeHeader(parseHeader(x)) is byte-identical`, () => {
    const bytes = load(c.file);
    assert.deepEqual(serializeHeader(parseHeader(bytes)), bytes.subarray(0, HEADER_SIZE));
  });
}

const golden = () => load('point27.skla').slice();
const patch16 = (b, off, v) => { new DataView(b.buffer).setUint16(off, v, true); return b; };
const isCode = (code) => (e) => e instanceof AssetFormatError && e.code === code;

test('rejects wrong magic', () => {
  for (let i = 0; i < 4; i++) {
    const b = golden();
    b[i] ^= 0x20;
    assert.throws(() => parseHeader(b), isCode('magic'));
  }
  assert.throws(() => parseHeader(new TextEncoder().encode('ply\nformat binary_little_endian 1.0\n'.padEnd(200, ' '))), isCode('magic'));
});

test('rejects old and future major versions, accepts a newer minor', () => {
  for (const major of [0, 2, 0xffff]) {
    assert.throws(() => parseHeader(patch16(golden(), OFFSETS.versionMajor, major)), isCode('version'));
  }
  const h = parseHeader(patch16(golden(), OFFSETS.versionMinor, 7));
  assert.equal(h.versionMinor, 7);
  assert.equal(h.pointCount, 32);
});

test('rejects short input, bad header_size and unknown format', () => {
  assert.throws(() => parseHeader(golden().subarray(0, HEADER_SIZE - 1)), isCode('short'));
  assert.throws(() => parseHeader(new Uint8Array(0)), isCode('short'));
  for (const hs of [0, 124, 130]) assert.throws(() => parseHeader(patch16(golden(), OFFSETS.headerSize, hs)), isCode('header_size'));
  assert.throws(() => parseHeader(patch16(golden(), OFFSETS.headerSize, 1024)), isCode('short'));
  for (const f of [0, 3, 255]) {
    const b = golden();
    b[OFFSETS.format] = f;
    assert.throws(() => parseHeader(b), isCode('format'));
  }
});

test('header with extension area, reserved bytes and newer minor round-trips byte-identically', () => {
  const base = parseHeader(load('gauss56.skla'));
  const ext = Uint8Array.from({ length: 8 }, (_, i) => 0xa0 + i);
  const reserved = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
  const bytes = serializeHeader({ ...base, versionMinor: 3, headerSize: HEADER_SIZE + 8, extension: ext, reserved });
  assert.equal(bytes.length, HEADER_SIZE + 8);
  const h = parseHeader(bytes);
  assert.equal(h.versionMinor, 3);
  assert.deepEqual(h.extension, ext);
  assert.deepEqual(h.reserved, reserved);
  assert.equal(h.segmentId, 7);
  assert.equal(h.level, 3);
  assert.deepEqual(serializeHeader(h), bytes);
});

test('ArrayBuffer and Buffer inputs give the same header', () => {
  const bytes = load('point27.skla');
  const a = parseHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const b = parseHeader(Buffer.from(bytes));
  assert.deepEqual(a, b);
});

test('serializeHeader rejects out-of-range fields', () => {
  const h = parseHeader(load('point27.skla'));
  assert.throws(() => serializeHeader({ ...h, level: 4 }), isCode('field'));
  assert.throws(() => serializeHeader({ ...h, segmentId: 2 ** 30 }), isCode('field'));
  assert.throws(() => serializeHeader({ ...h, pointCount: -1 }), isCode('field'));
  assert.throws(() => serializeHeader({ ...h, tileX: 2 ** 31 }), isCode('field'));
  assert.throws(() => serializeHeader({ ...h, bboxMin: [0, NaN, 0] }), isCode('field'));
  assert.throws(() => serializeHeader({ ...h, format: 3 }), isCode('format'));
  assert.throws(() => serializeHeader({ ...h, headerSize: 130 }), isCode('header_size'));
  assert.throws(() => serializeHeader({ ...h, headerSize: 136, extension: new Uint8Array(4) }), isCode('field'));
});

test('bodyLayout: planes are 4-byte aligned and source record sizes are 27 and 56', () => {
  assert.equal(SOURCE_RECORD_BYTES[FORMAT_POINT27], 3 * 4 + 3 * 4 + 3);
  assert.equal(SOURCE_RECORD_BYTES[FORMAT_GAUSS56], 14 * 4);
  // n=1: 점 3*4(u16 평면 2 B → 4) + 5*4 = 32, 가우시안 3*4 + 7*4 + 4 = 44
  assert.equal(bodyLayout(FORMAT_POINT27, 1).requiredBytes, 32);
  assert.equal(bodyLayout(FORMAT_GAUSS56, 1).requiredBytes, 44);
  for (const f of [FORMAT_POINT27, FORMAT_GAUSS56]) {
    for (const p of bodyLayout(f, 13).planes) assert.equal(p.offset % 4, 0);
  }
  assert.throws(() => bodyLayout(9, 1), isCode('format'));
});

test('sub-task interfaces exist and are stubs until implemented', () => {
  const names = [
    'readHeaderStrict', 'writeHeader', 'tileOf', 'tileBounds', 'groupByTile', 'computeBounds', 'chooseQuantExp', 'quantizedBox',
    'packSegLevel', 'unpackSegLevel', 'levelOfStep', 'encodeChunkKey', 'decodeChunkKey', 'crc32', 'computeChecksum', 'verifyChecksum',
    'validateAsset', 'unpackChunk', 'toSourceRecords', 'decodeOctNormal', 'decodeRotation', 'packChunk', 'encodeOctNormal',
    'encodeRotation', 'readHeaderClient', 'readPlanesClient', 'checkDeterminism', 'checkCompat',
  ];
  for (const n of names) {
    assert.equal(typeof asset[n], 'function', n);
    assert.throws(() => asset[n](), new RegExp(`not implemented: ${n} `), n);
  }
});
