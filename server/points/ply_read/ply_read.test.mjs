import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPly } from './index.mjs';
import { PointsError, POINT27_PROPERTIES, GAUSS56_PROPERTIES } from '../../../contracts/points/index.mjs';

// 헤더 문자열 합성
const header = (n, props) => Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property ${p.type} ${p.name}`).join('\n')}\nend_header\n`, 'latin1');

// 27 B 점 i: (i, 2i+0.5, -i), 법선 (0,0,1), 색 (i, 255-i, 7i%256)
function build27(n) {
  const h = header(n, POINT27_PROPERTIES);
  const b = Buffer.alloc(h.length + 27 * n); h.copy(b);
  for (let i = 0; i < n; i++) {
    const o = h.length + 27 * i;
    b.writeFloatLE(i, o); b.writeFloatLE(2 * i + 0.5, o + 4); b.writeFloatLE(-i, o + 8);
    b.writeFloatLE(0, o + 12); b.writeFloatLE(0, o + 16); b.writeFloatLE(1, o + 20);
    b[o + 24] = i; b[o + 25] = 255 - i; b[o + 26] = (7 * i) % 256;
  }
  return b;
}
// 56 B 가우시안 i: 위치 (0.5i, -i, 2), fdc (0.25,0.5,0.75), opacity i-10, scale (-1,-2,-3), rot (1,0,0,i)
function build56(n) {
  const h = header(n, GAUSS56_PROPERTIES);
  const b = Buffer.alloc(h.length + 56 * n); h.copy(b);
  for (let i = 0; i < n; i++) {
    const v = [0.5 * i, -i, 2, 0.25, 0.5, 0.75, i - 10, -1, -2, -3, 1, 0, 0, i];
    v.forEach((x, j) => b.writeFloatLE(x, h.length + 56 * i + 4 * j));
  }
  return b;
}

const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof PointsError); return e.code; } return null; };

test('ply_read_golden', () => {
  // 27 B: 32점. 첫 점 (0,0.5,0)·색(0,255,0), 끝 점 i=31: (31,62.5,-31)·색(31,224,217)
  const c = readPly(build27(32));
  assert.equal(c.format, 1); assert.equal(c.count, 32);
  assert.equal(c.positions.length, 96); assert.equal(c.colors.length, 96);
  assert.deepEqual([...c.positions.subarray(0, 3)], [0, 0.5, -0]);
  assert.deepEqual([...c.positions.subarray(93, 96)], [31, 62.5, -31]);
  assert.deepEqual([...c.normals.subarray(93, 96)], [0, 0, 1]);
  assert.deepEqual([...c.colors.subarray(0, 3)], [0, 255, 0]);
  assert.deepEqual([...c.colors.subarray(93, 96)], [31, 224, 217]);

  // 56 B: 21점. 첫 점 위치 (0,0,2)·opacity -10·rot(1,0,0,0), 끝 점 i=20: (10,-20,2)·opacity 10·rot(1,0,0,20)
  const g = readPly(build56(21));
  assert.equal(g.format, 2); assert.equal(g.count, 21);
  assert.equal(g.opacity.length, 21); assert.equal(g.rotations.length, 84); assert.equal(g.scales.length, 63);
  assert.deepEqual([...g.positions.subarray(0, 3)], [0, -0, 2]);
  assert.deepEqual([...g.positions.subarray(60, 63)], [10, -20, 2]);
  assert.deepEqual([...g.fdc.subarray(60, 63)], [0.25, 0.5, 0.75]);
  assert.equal(g.opacity[0], -10); assert.equal(g.opacity[20], 10);
  assert.deepEqual([...g.scales.subarray(60, 63)], [-1, -2, -3]);
  assert.deepEqual([...g.rotations.subarray(0, 4)], [1, 0, 0, 0]);
  assert.deepEqual([...g.rotations.subarray(80, 84)], [1, 0, 0, 20]);

  // 바이트 오프셋이 0 이 아닌 뷰도 읽는다
  const big = Buffer.concat([Buffer.alloc(5), build27(3)]);
  assert.equal(readPly(big.subarray(5)).count, 3);

  // 크기 불일치(모자람·남음)
  const a = build27(4);
  assert.equal(code(() => readPly(a.subarray(0, a.length - 1))), 'size');
  assert.equal(code(() => readPly(Buffer.concat([build56(2), Buffer.alloc(1)]))), 'size');
  // 헤더 오류
  assert.equal(code(() => readPly(Buffer.from('not a ply'))), 'header');
  // 속성 순서 다름
  const swapped = [...POINT27_PROPERTIES]; [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.equal(code(() => readPly(Buffer.concat([header(1, swapped), Buffer.alloc(27)]))), 'format');
  // double 좌표 거부(stride 39)
  const dbl = POINT27_PROPERTIES.map((p, i) => (i < 3 ? { ...p, type: 'double' } : p));
  assert.equal(code(() => readPly(Buffer.concat([header(1, dbl), Buffer.alloc(39)]))), 'format');
  // 형식 불명(xyz 만)
  const unk = [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }, { name: 'z', type: 'float' }];
  assert.equal(code(() => readPly(Buffer.concat([header(1, unk), Buffer.alloc(12)]))), 'format');
});
