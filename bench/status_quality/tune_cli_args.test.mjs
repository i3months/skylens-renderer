// tune_cli.mjs 의 인자 검증 함수 단위 시험.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCountAndSeed, parseVariant } from './cli_args.mjs';

// parseCountAndSeed 시험: 시드 검증
for (const bad of ['0', 'abc', '-1', '1.5', '', '1e3x', '1e3', '0x10', ' 1', '9007199254740993']) {
  test(`parseCountAndSeed: 잘못된 시드 ${JSON.stringify(bad)} 는 RangeError 를 던진다`, () => {
    assert.throws(() => parseCountAndSeed(undefined, bad), RangeError);
  });
}

// parseCountAndSeed 시험: 점 수 검증
for (const bad of ['0', 'abc', '-1', '1.5', '', '1e3x', '1e3', '0x10', ' 1', '9007199254740993']) {
  test(`parseCountAndSeed: 잘못된 점 수 ${JSON.stringify(bad)} 는 RangeError 를 던진다`, () => {
    assert.throws(() => parseCountAndSeed(bad, undefined), RangeError);
  });
}

// parseCountAndSeed 시험: 유효 값
test('parseCountAndSeed: 유효 시드 "1" 과 점 수 "1000000" 을 받아들인다', () => {
  const result = parseCountAndSeed('1000000', '1');
  assert.deepEqual(result, { count: 1000000, seed: 1 });
});

test('parseCountAndSeed: 유효 시드 "7" 과 기본 점 수를 받아들인다', () => {
  const result = parseCountAndSeed(undefined, '7');
  assert.deepEqual(result, { count: 2500000, seed: 7 });
});

test('parseCountAndSeed: 기본 시드와 유효 점 수 "1000000" 을 받아들인다', () => {
  const result = parseCountAndSeed('1000000', undefined);
  assert.deepEqual(result, { count: 1000000, seed: 1 });
});

test('parseCountAndSeed: 둘 다 undefined 일 때 기본값을 반환한다', () => {
  const result = parseCountAndSeed(undefined, undefined);
  assert.deepEqual(result, { count: 2500000, seed: 1 });
});

// parseVariant 시험: 알 수 없는 variant
for (const bad of ['abc', 'building', 'FLAT_BOXES', 'depth-noise', '', '1', 'flat_box']) {
  test(`parseVariant: 알 수 없는 variant ${JSON.stringify(bad)} 는 RangeError 를 던진다`, () => {
    assert.throws(() => parseVariant(bad), RangeError);
  });
}

// parseVariant 시험: 유효 variant
for (const valid of ['flat_boxes', 'depth_noise', 'buildings']) {
  test(`parseVariant: 유효 variant ${JSON.stringify(valid)} 를 받아들인다`, () => {
    const result = parseVariant(valid);
    assert.equal(result, valid);
  });
}

test('parseVariant: undefined 일 때 기본값 "flat_boxes" 를 반환한다', () => {
  const result = parseVariant(undefined);
  assert.equal(result, 'flat_boxes');
});
