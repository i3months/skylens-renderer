import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUSVIEW_METHOD_MAP, STATUSVIEW_API, STATUS_INPUT_MESSAGES, sceneToEnu, enuToScene, assertViewport, STATUS_BANDWIDTH_LIMITS, STATUS_QUALITY_MIN_SSIM } from './index.mjs';
import { MSG } from '../proto/index.mjs';

test('대응표의 모든 항목이 API 서명을 가진다', () => {
  assert.equal(STATUSVIEW_METHOD_MAP.length, 8);
  for (const row of STATUSVIEW_METHOD_MAP) {
    assert.ok(STATUSVIEW_API[row.fn], row.fn);
    assert.equal(row.origin, 'estimated');
  }
  assert.equal(new Set(STATUSVIEW_METHOD_MAP.map((r) => r.module)).size, 8);
});

test('입력 메시지 이름은 모두 proto 의 s2c 종류다', () => {
  for (const name of STATUS_INPUT_MESSAGES) assert.ok(MSG[name] !== undefined, name);
});

test('씬 ↔ ENU 변환은 서로 역이고 −0 을 만들지 않는다', () => {
  assert.deepEqual(sceneToEnu([1, 2, -3]), [1, 3, 2]);
  assert.deepEqual(enuToScene([1, 3, 2]), [1, 2, -3]);
  assert.ok(Object.is(sceneToEnu([0, 0, 0])[1], 0));
  assert.deepEqual(enuToScene(sceneToEnu([4, 5, 6])), [4, 5, 6]);
  assert.throws(() => sceneToEnu([1, 2]), TypeError);
  assert.throws(() => sceneToEnu([1, NaN, 2]), TypeError);
});

test('뷰포트 검사', () => {
  assertViewport({ width: 800, height: 600, devicePixelRatio: 2 });
  assert.throws(() => assertViewport({ width: 0, height: 600, devicePixelRatio: 1 }), RangeError);
  assert.throws(() => assertViewport({ width: 8, height: 6, devicePixelRatio: 0 }), RangeError);
  assert.throws(() => assertViewport(null), TypeError);
});

test('측정 문턱 상수는 SPEC 수치다', () => {
  assert.equal(STATUS_BANDWIDTH_LIMITS.initialBytes, 15_000_000);
  assert.equal(STATUS_BANDWIDTH_LIMITS.perSegmentBytes, undefined); // 구간 상한 폐지(관제탑 3 MB 는 별개)
  assert.equal(STATUS_QUALITY_MIN_SSIM, 0.95);
});
