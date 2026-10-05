// F-391 ④: 짝 검정 t === null 이면 배제 못 한 이동량을 0 이 아니라 NaN 으로 두는 대입과, 그 NaN 이 unmeasuredLocalBlocks 로 세이는 연결.
// t === null 입력을 합성 영상으로 만들지 못해(drape_unmeasured.test.mjs 머리 참조) 대입을 unexcludedOrNaN 으로 분리해 직접 시험한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unexcludedOrNaN, unexcludedSummary } from './index.mjs';

test('t === null 이면 NaN 이고 compute 를 부르지 않는다', () => {
  let called = 0;
  const v = unexcludedOrNaN(null, () => { called++; return 0.75; });
  assert.ok(Number.isNaN(v));
  assert.equal(called, 0);
});

test('t 가 수이면 compute 값을 그대로 쓴다(0 포함)', () => {
  assert.equal(unexcludedOrNaN(1.5, () => 0.75), 0.75);
  assert.equal(unexcludedOrNaN(0, () => 0), 0);
});

test('null → NaN 대입 결과가 집계에서 unmeasuredLocalBlocks 1, 상한 오염 없음', () => {
  const blocks = [
    { local: true, unexcludedPx: unexcludedOrNaN(null, () => 9) },
    { local: true, unexcludedPx: unexcludedOrNaN(2, () => 1.25) },
  ];
  assert.deepEqual(unexcludedSummary(blocks), { unexcludedMaxPx: 1.25, unmeasuredLocalBlocks: 1 });
});
