import test from 'node:test';
import assert from 'node:assert/strict';
import { identifySegments } from './index.mjs';
import { PointsError } from '../../../contracts/points/index.mjs';

const bad = (names) => assert.throws(() => identifySegments(names), (e) => e instanceof PointsError && e.code === 'name');

test('4수준×3구간 섞인 순서 식별', () => {
  const names = [
    'seg2_step07000.ply', 'seg0_step01000.ply', 'seg1_step00250.ply', 'seg2_step00250.ply',
    'seg0_step07000.ply', 'seg1_step03500.ply', 'seg0_step00250.ply', 'seg2_step03500.ply',
    'seg1_step07000.ply', 'seg0_step03500.ply', 'seg2_step01000.ply', 'seg1_step01000.ply',
  ];
  const got = identifySegments(names).map((r) => [r.segmentId, r.level, r.fileName]);
  assert.deepEqual(got, [
    [0, 0, 'seg0_step00250.ply'], [0, 1, 'seg0_step01000.ply'], [0, 2, 'seg0_step03500.ply'], [0, 3, 'seg0_step07000.ply'],
    [1, 0, 'seg1_step00250.ply'], [1, 1, 'seg1_step01000.ply'], [1, 2, 'seg1_step03500.ply'], [1, 3, 'seg1_step07000.ply'],
    [2, 0, 'seg2_step00250.ply'], [2, 1, 'seg2_step01000.ply'], [2, 2, 'seg2_step03500.ply'], [2, 3, 'seg2_step07000.ply'],
  ]);
});

test('실제 demo 이름 샘플', () => {
  const got = identifySegments(['seg12_step07000.ply', 'seg0_step00250.ply', 'seg15_step03500.ply', 'seg9_step01000.ply']);
  assert.deepEqual(got.map((r) => [r.segmentId, r.level]), [[0, 0], [9, 1], [12, 3], [15, 2]]);
});

test('빈 목록은 빈 결과', () => assert.deepEqual(identifySegments([]), []));

test('규칙 밖 이름은 name 오류', () => {
  for (const n of [
    'SEG0_step00250.ply', 'seg0_STEP00250.ply', 'seg0_step00250.PLY', 'seg0_step00250.ply.bak', 'seg0_step00250.txt',
    'seg00_step00250.ply', 'seg01_step00250.ply', 'seg_step00250.ply', 'seg-1_step00250.ply',
    'seg0_step00123.ply', 'seg0_step0250.ply', 'seg0_step000250.ply', 'seg0_step00001.ply',
    'dir/seg0_step00250.ply', 'dir\\seg0_step00250.ply', 'seg0_step00250.ply\n', 'seg1073741824_step00250.ply', 42,
  ]) bad([n]);
});

test('같은 (구간, 수준) 중복은 name 오류', () => {
  bad(['seg3_step01000.ply', 'seg0_step00250.ply', 'seg3_step01000.ply']);
});
