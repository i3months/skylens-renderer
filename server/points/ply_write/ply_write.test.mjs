import test from 'node:test';
import assert from 'node:assert/strict';
import { writePly } from './index.mjs';
import { parsePlyHeader } from '../../../contracts/ply/index.mjs';
import { FORMAT_POINT27, FORMAT_GAUSS56, PointsError, detectFormat } from '../../../contracts/points/index.mjs';

const f32 = (n, seed) => Float32Array.from({ length: n }, (_, i) => Math.fround(Math.sin(i * 1.7 + seed) * 100));
const mk27 = (n) => ({ format: FORMAT_POINT27, count: n, positions: f32(3 * n, 1), normals: f32(3 * n, 2), colors: Uint8Array.from({ length: 3 * n }, (_, i) => (i * 37) & 255) });
const mk56 = (n) => ({
  format: FORMAT_GAUSS56, count: n, positions: f32(3 * n, 1), fdc: f32(3 * n, 2), opacity: f32(n, 3),
  scales: f32(3 * n, 4), rotations: f32(4 * n, 5),
});

// 테스트 안 최소 읽기 헬퍼(ply_read 가 아직 없을 수 있음). 값 단위로 읽는다.
function read(bytes) {
  const h = parsePlyHeader(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = h.vertexCount;
  const F = (o) => dv.getFloat32(o, true);
  const base = (i) => h.headerBytes + i * h.stride;
  if (h.stride === 27) {
    const c = { format: 1, count: n, positions: new Float32Array(3 * n), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) };
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        c.positions[3 * i + k] = F(base(i) + 4 * k);
        c.normals[3 * i + k] = F(base(i) + 12 + 4 * k);
        c.colors[3 * i + k] = dv.getUint8(base(i) + 24 + k);
      }
    }
    return c;
  }
  const c = { format: 2, count: n, positions: new Float32Array(3 * n), fdc: new Float32Array(3 * n), opacity: new Float32Array(n), scales: new Float32Array(3 * n), rotations: new Float32Array(4 * n) };
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      c.positions[3 * i + k] = F(base(i) + 4 * k);
      c.fdc[3 * i + k] = F(base(i) + 12 + 4 * k);
      c.scales[3 * i + k] = F(base(i) + 28 + 4 * k);
    }
    c.opacity[i] = F(base(i) + 24);
    for (let k = 0; k < 4; k++) c.rotations[4 * i + k] = F(base(i) + 40 + 4 * k);
  }
  return c;
}

// 원본 바이트 -> 열 배열(비트 그대로) 헬퍼
function readBits(raw) {
  const h = parsePlyHeader(raw);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const n = h.vertexCount;
  const c = h.stride === 27 ? mk27(n) : mk56(n);
  const cp = (a, m, i, o, w) => { const dst = new DataView(a.buffer); for (let k = 0; k < w; k++) dst.setUint32((i * m + k) * 4, dv.getUint32(o + k * 4, true), true); };
  for (let i = 0; i < n; i++) {
    const o = h.headerBytes + i * h.stride;
    cp(c.positions, 3, i, o, 3);
    if (h.stride === 27) { cp(c.normals, 3, i, o + 12, 3); c.colors.set(raw.subarray(o + 24, o + 27), i * 3); }
    else { cp(c.fdc, 3, i, o + 12, 3); cp(c.opacity, 1, i, o + 24, 1); cp(c.scales, 3, i, o + 28, 3); cp(c.rotations, 4, i, o + 40, 4); }
  }
  return c;
}

// 헤더 구조를 줄 단위로 검증하는 헬퍼: 형식 줄, element vertex 줄, 속성 목록·순서, end_header 를 검사한다
// 주석 변경에 깨지지 않음
function assertHeaderStructure(bytes, expectedCount, expectedFormat) {
  const headerEnd = 'end_header\n';
  const headerStr = Buffer.from(bytes).toString('latin1');
  const headerEndIdx = headerStr.indexOf(headerEnd);
  assert.ok(headerEndIdx >= 0, 'end_header 를 찾아야 함');

  const lines = headerStr.slice(0, headerEndIdx).split('\n').filter((l) => l.trim().length > 0);
  assert.equal(lines[0], 'ply', 'ply 매직');

  // format 줄 검사
  const formatLine = lines.find((l) => l.startsWith('format'));
  assert.ok(formatLine, 'format 줄이 있어야 함');
  assert.equal(formatLine, 'format binary_little_endian 1.0', '형식이 binary_little_endian 1.0 이어야 함');

  // element vertex 줄 검사
  const elemVertexLine = lines.find((l) => l.startsWith('element vertex'));
  assert.ok(elemVertexLine, 'element vertex 줄이 있어야 함');
  assert.equal(elemVertexLine, `element vertex ${expectedCount}`, `element vertex 줄이 ${expectedCount} 을 가져야 함`);

  // 속성 목록·순서 검사
  const h = parsePlyHeader(bytes);
  assert.equal(detectFormat(h.properties), expectedFormat, '형식이 일치해야 함');
}

for (const [name, mk, st, fmt] of [['27', mk27, 27, 1], ['56', mk56, 56, 2]]) {
  test(`헤더·크기 ${name}`, () => {
    const out = writePly(mk(5));
    const h = parsePlyHeader(out);
    assert.equal(h.stride, st);
    assert.equal(h.vertexCount, 5);
    assert.equal(detectFormat(h.properties), fmt);
    assert.equal(out.length, h.headerBytes + st * 5);
    assertHeaderStructure(out, 5, fmt);
  });
  test(`왕복 열 배열 동일 ${name}`, () => {
    const c = mk(40);
    assert.deepEqual(read(writePly(c)), c);
  });
  test(`빈 점군 ${name}`, () => {
    const out = writePly(mk(0));
    const h = parsePlyHeader(out);
    assert.equal(h.vertexCount, 0);
    assert.equal(out.length, h.headerBytes);
  });
  test(`바이트 왕복 동일(임의 비트·NaN 포함) ${name}`, () => {
    const h = parsePlyHeader(writePly(mk(10)));
    const raw = Uint8Array.from(writePly(mk(10)));
    for (let i = h.headerBytes; i < raw.length; i += 3) raw[i] = (i * 13) & 255;
    assert.deepEqual(writePly(readBits(raw)), raw);
  });
}

test('음성: 길이 불일치는 size', () => {
  const c = mk27(4); c.count = 5;
  assert.throws(() => writePly(c), (e) => e instanceof PointsError && e.code === 'size');
  const g = mk56(4); g.opacity = new Float32Array(3);
  assert.throws(() => writePly(g), (e) => e instanceof PointsError && e.code === 'size');
  const k = mk27(4); k.colors = new Uint8Array(11);
  assert.throws(() => writePly(k), (e) => e.code === 'size');
});
test('음성: count 오류는 size', () => {
  for (const bad of [-1, 1.5, NaN, '3', undefined]) {
    const c = mk27(2); c.count = bad;
    assert.throws(() => writePly(c), (e) => e instanceof PointsError && e.code === 'size');
  }
});
test('음성: 형식 오류는 format', () => {
  assert.throws(() => writePly({ ...mk27(1), format: 9 }), (e) => e.code === 'format');
  assert.throws(() => writePly(null), (e) => e.code === 'format');
  assert.throws(() => writePly({ ...mk27(1), positions: [1, 2, 3] }), (e) => e.code === 'format');
  assert.throws(() => writePly({ ...mk56(1), rotations: new Float64Array(4) }), (e) => e.code === 'format');
});
