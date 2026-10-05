// F-391 ④: 분리 함수 unexcludedOrNaN 과 집계 unexcludedSummary 의 단위 시험(공개 API 의 호출부 연결은 지키지 않는다).
// 조사 결과 호출부의 t === null 은 공개 API(measureDrapeAlignment)로 도달할 수 없다: 예측 위치를 잴 수 없는 블록은 settle 의 search 가
// 시작 비용 Infinity − Infinity = NaN 비교로 후보를 못 바꿔 null 을 내고, 짝 검정 경로(out === false)에 들어오지 못한다.
// 약 17,000 입력에서 0건. 그래서 호출부 변이(`? NaN` → `? 0`)는 공개 출력이 같은 동등 변이다.
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
