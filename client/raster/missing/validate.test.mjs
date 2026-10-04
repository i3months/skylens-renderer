import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nonEmptyValuesInEmpty, computeCoverage, compareWithReference } from './index.mjs';
import { emptyResult } from '../../../contracts/raster/index.mjs';

// nonEmptyValuesInEmpty 입력 검증: result 객체가 유효해야 함
test('nonEmptyValuesInEmpty: null·원시값 result 는 missing: 오류', () => {
  const ok = [0];
  for (const bad of [null, undefined, 5, 'x']) {
    assert.throws(() => nonEmptyValuesInEmpty(bad, ok), /^Error: missing:/, `result=${bad}`);
  }
});

// nonEmptyValuesInEmpty 입력 검증: 빈 객체 result 는 missing: 오류
test('nonEmptyValuesInEmpty: 빈 객체 {} 는 missing: 오류', () => {
  assert.throws(() => nonEmptyValuesInEmpty({}, [0]), /^Error: missing:/);
});

// nonEmptyValuesInEmpty 입력 검증: 잘못된 RenderResult(버퍼 크기 불일치) 는 missing: 오류
test('nonEmptyValuesInEmpty: RenderResult 버퍼 크기 불일치는 missing: 오류', () => {
  const bad = {
    width: 2, height: 2,
    color: new Uint8Array(5),
    depth: new Float32Array(4),
    index: new Int32Array(4),
  };
  assert.throws(() => nonEmptyValuesInEmpty(bad, [0]), /^Error: missing:/);
});

// nonEmptyValuesInEmpty 입력 검증: emptyPixels 이 배열이 아니면 missing: 오류
test('nonEmptyValuesInEmpty: emptyPixels 이 배열이 아니면 missing: 오류', () => {
  const r = emptyResult(2, 2);
  for (const bad of [null, undefined, 5, 'x', {}]) {
    assert.throws(() => nonEmptyValuesInEmpty(r, bad), /^Error: missing:/, `emptyPixels=${bad}`);
  }
});

// nonEmptyValuesInEmpty 입력 검증: emptyPixels 배열이 범위를 벗어나면 missing: 오류
test('nonEmptyValuesInEmpty: 범위 벗어난 인덱스는 missing: 오류', () => {
  const r = emptyResult(2, 2);  // 4 픽셀(인덱스 0-3)
  assert.throws(() => nonEmptyValuesInEmpty(r, [4]), /^Error: missing:/, 'index=4 (범위 벗어남)');
  assert.throws(() => nonEmptyValuesInEmpty(r, [10]), /^Error: missing:/, 'index=10 (범위 벗어남)');
  assert.throws(() => nonEmptyValuesInEmpty(r, [-1]), /^Error: missing:/, 'index=-1 (음수)');
  assert.throws(() => nonEmptyValuesInEmpty(r, [0, 5]), /^Error: missing:/, 'mixed: 0 ok but 5 out of range');
});

// nonEmptyValuesInEmpty 입력 검증: 정수가 아닌 인덱스는 missing: 오류
test('nonEmptyValuesInEmpty: 정수가 아닌 인덱스는 missing: 오류', () => {
  const r = emptyResult(2, 2);
  assert.throws(() => nonEmptyValuesInEmpty(r, [1.5]), /^Error: missing:/);
  assert.throws(() => nonEmptyValuesInEmpty(r, [NaN]), /^Error: missing:/);
  assert.throws(() => nonEmptyValuesInEmpty(r, [Infinity]), /^Error: missing:/);
});

// nonEmptyValuesInEmpty 정상 동작: 빈 픽셀 배열이 모두 빈 값이면 빈 목록 반환
test('nonEmptyValuesInEmpty: 빈 픽셀이 모두 빈 값이면 빈 목록', () => {
  const r = emptyResult(2, 2);  // 모든 픽셀이 빈 값(index=-1, depth=0, color=[0,0,0])
  const result = nonEmptyValuesInEmpty(r, [0, 1, 2, 3]);
  assert.deepEqual(result, []);
});

// nonEmptyValuesInEmpty 정상 동작: 칠해진 픽셀을 올바르게 감지
test('nonEmptyValuesInEmpty: 칠해진 픽셀을 감지', () => {
  const r = emptyResult(3, 1);
  // 픽셀 0: 칠함 → 빈 값이 아님
  r.index[0] = 5;
  r.depth[0] = 10;
  r.color[0] = 100;

  // 빈 것으로 표시된 픽셀[0]이 실제로는 칠해져 있으므로 감지됨
  const result = nonEmptyValuesInEmpty(r, [0]);
  assert.deepEqual(result, [0]);
});

// nonEmptyValuesInEmpty 정상 동작: 일부만 어긋나면 그것들만 반환
test('nonEmptyValuesInEmpty: 일부 어긋난 픽셀만 감지', () => {
  const r = emptyResult(3, 3);
  r.index[4] = 0;  // 중앙 픽셀만 칠함
  r.depth[4] = 5;  // depth 도 설정해야 함
  const result = nonEmptyValuesInEmpty(r, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(result, [4]);
});

// computeCoverage: 0×0 및 음수 크기는 RenderResult 로도 missing: 오류
test('computeCoverage: RenderResult 0×0는 missing: 오류', () => {
  const r0x0 = {
    width: 0, height: 0,
    color: new Uint8Array(0),
    depth: new Float32Array(0),
    index: new Int32Array(0),
  };
  assert.throws(() => computeCoverage(r0x0), /^Error: missing:/);
});

// compareWithReference: 0×0 및 음수 크기는 RenderResult 로도 missing: 오류
test('compareWithReference: RenderResult 음수 크기는 missing: 오류', () => {
  const rNeg = {
    width: -2, height: 3,
    color: new Uint8Array(0),
    depth: new Float32Array(0),
    index: new Int32Array(0),
  };
  const rOk = {
    width: 2, height: 3,
    color: new Uint8Array(18),
    depth: new Float32Array(6),
    index: new Int32Array(6),
  };
  assert.throws(() => compareWithReference(rNeg, rOk), /^Error: missing:/);
  assert.throws(() => compareWithReference(rOk, rNeg), /^Error: missing:/);
});

// nonEmptyValuesInEmpty: 큰 배열에서도 범위 검사 정상 작동
test('nonEmptyValuesInEmpty: 큰 배열에서 범위 검사', () => {
  const r = emptyResult(100, 100);  // 10000 픽셀(인덱스 0-9999)
  // 9999는 유효한 범위이므로 오류가 아님:
  const result = nonEmptyValuesInEmpty(r, [9999]);
  assert.deepEqual(result, []);  // 픽셀 9999는 빈 값이므로 빈 목록
});

// nonEmptyValuesInEmpty: 10000은 범위 벗어남
test('nonEmptyValuesInEmpty: 범위 밖 인덱스 감지(100×100 배열)', () => {
  const r = emptyResult(100, 100);
  assert.throws(() => nonEmptyValuesInEmpty(r, [10000]), /^Error: missing:/);
});
