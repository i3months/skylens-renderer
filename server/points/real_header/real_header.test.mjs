import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPly } from '../ply_read/index.mjs';
import { GAUSS56_PROPERTIES } from '../../../contracts/points/index.mjs';

// 실제 skylens 56 B 자산 헤더(ply, format binary_little_endian 1.0, element vertex N, properties x y z f_dc_0..2 opacity scale_0..2 rot_0..3)
test('real_header_56b_golden', () => {
  // PLY 헤더를 정확한 속성 순서로 구성: x y z f_dc_0 f_dc_1 f_dc_2 opacity scale_0 scale_1 scale_2 rot_0 rot_1 rot_2 rot_3
  const headerStr = 'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n';
  const headerBuf = Buffer.from(headerStr, 'latin1');

  // 3점의 바디 생성: 각 점은 56 바이트
  const bodyBuf = Buffer.alloc(3 * 56);
  const dv = new DataView(bodyBuf.buffer);

  // 점 0: 위치 (0.5, 1.5, 2.5), fdc (0.1, 0.2, 0.3), opacity -5, scale (1, 2, 3), rot (0.7071, 0, 0, 0.7071)
  dv.setFloat32(0, 0.5, true);
  dv.setFloat32(4, 1.5, true);
  dv.setFloat32(8, 2.5, true);
  dv.setFloat32(12, 0.1, true);
  dv.setFloat32(16, 0.2, true);
  dv.setFloat32(20, 0.3, true);
  dv.setFloat32(24, -5, true);
  dv.setFloat32(28, 1, true);
  dv.setFloat32(32, 2, true);
  dv.setFloat32(36, 3, true);
  dv.setFloat32(40, 0.7071, true);
  dv.setFloat32(44, 0, true);
  dv.setFloat32(48, 0, true);
  dv.setFloat32(52, 0.7071, true);

  // 점 1: 위치 (10, 20, 30), fdc (0.5, 0.5, 0.5), opacity 0, scale (-1, -2, -3), rot (1, 0, 0, 0)
  dv.setFloat32(56, 10, true);
  dv.setFloat32(60, 20, true);
  dv.setFloat32(64, 30, true);
  dv.setFloat32(68, 0.5, true);
  dv.setFloat32(72, 0.5, true);
  dv.setFloat32(76, 0.5, true);
  dv.setFloat32(80, 0, true);
  dv.setFloat32(84, -1, true);
  dv.setFloat32(88, -2, true);
  dv.setFloat32(92, -3, true);
  dv.setFloat32(96, 1, true);
  dv.setFloat32(100, 0, true);
  dv.setFloat32(104, 0, true);
  dv.setFloat32(108, 0, true);

  // 점 2: 위치 (-5, -10, 15), fdc (0.9, 0.8, 0.7), opacity 10, scale (0.5, 1.5, 2.5), rot (0, 1, 0, 0)
  dv.setFloat32(112, -5, true);
  dv.setFloat32(116, -10, true);
  dv.setFloat32(120, 15, true);
  dv.setFloat32(124, 0.9, true);
  dv.setFloat32(128, 0.8, true);
  dv.setFloat32(132, 0.7, true);
  dv.setFloat32(136, 10, true);
  dv.setFloat32(140, 0.5, true);
  dv.setFloat32(144, 1.5, true);
  dv.setFloat32(148, 2.5, true);
  dv.setFloat32(152, 0, true);
  dv.setFloat32(156, 1, true);
  dv.setFloat32(160, 0, true);
  dv.setFloat32(164, 0, true);

  // 완전한 PLY 파일
  const plyBuf = Buffer.concat([headerBuf, bodyBuf]);

  // readPly 로 읽기
  const result = readPly(plyBuf);

  // 형식 확인: 56B 가우시안(형식 2)
  assert.equal(result.format, 2, '형식이 2(GAUSS56)여야 함');

  // 점 수 확인
  assert.equal(result.count, 3, '점 수가 3이어야 함');

  // 첫 점 확인: 위치 (0.5, 1.5, 2.5), fdc (0.1, 0.2, 0.3), opacity -5
  const tol = 1e-6;
  const assertClose = (actual, expected, name) => {
    assert.ok(Math.abs(actual - expected) < tol, `${name}: expected ${expected}, got ${actual}`);
  };

  // 위치 확인
  assertClose(result.positions[0], 0.5, '첫 점 위치[0]');
  assertClose(result.positions[1], 1.5, '첫 점 위치[1]');
  assertClose(result.positions[2], 2.5, '첫 점 위치[2]');

  // fdc 확인 (float32 정밀도)
  assertClose(result.fdc[0], 0.1, '첫 점 fdc[0]');
  assertClose(result.fdc[1], 0.2, '첫 점 fdc[1]');
  assertClose(result.fdc[2], 0.3, '첫 점 fdc[2]');

  // opacity 확인
  assert.equal(result.opacity[0], -5, '첫 점의 opacity');

  // scale 확인
  assertClose(result.scales[0], 1, '첫 점 scale[0]');
  assertClose(result.scales[1], 2, '첫 점 scale[1]');
  assertClose(result.scales[2], 3, '첫 점 scale[2]');

  // rotation 확인
  assertClose(result.rotations[0], 0.7071, '첫 점의 rotation[0]');
  assertClose(result.rotations[1], 0, '첫 점의 rotation[1]');
  assertClose(result.rotations[2], 0, '첫 점의 rotation[2]');
  assertClose(result.rotations[3], 0.7071, '첫 점의 rotation[3]');

  // 마지막 점(점 2) 확인: 위치 (-5, -10, 15), fdc (0.9, 0.8, 0.7), opacity 10
  assertClose(result.positions[6], -5, '마지막 점 위치[0]');
  assertClose(result.positions[7], -10, '마지막 점 위치[1]');
  assertClose(result.positions[8], 15, '마지막 점 위치[2]');

  assertClose(result.fdc[6], 0.9, '마지막 점 fdc[0]');
  assertClose(result.fdc[7], 0.8, '마지막 점 fdc[1]');
  assertClose(result.fdc[8], 0.7, '마지막 점 fdc[2]');

  assert.equal(result.opacity[2], 10, '마지막 점의 opacity');

  assertClose(result.scales[6], 0.5, '마지막 점 scale[0]');
  assertClose(result.scales[7], 1.5, '마지막 점 scale[1]');
  assertClose(result.scales[8], 2.5, '마지막 점 scale[2]');

  assertClose(result.rotations[8], 0, '마지막 점의 rotation[0]');
  assertClose(result.rotations[9], 1, '마지막 점의 rotation[1]');
  assertClose(result.rotations[10], 0, '마지막 점의 rotation[2]');
  assertClose(result.rotations[11], 0, '마지막 점의 rotation[3]');

  // 속성 순서가 정확한지 확인
  assert.equal(result.positions.length, 9, 'positions 배열 길이');
  assert.equal(result.fdc.length, 9, 'fdc 배열 길이');
  assert.equal(result.opacity.length, 3, 'opacity 배열 길이');
  assert.equal(result.scales.length, 9, 'scales 배열 길이');
  assert.equal(result.rotations.length, 12, 'rotations 배열 길이');
});
