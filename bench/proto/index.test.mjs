// 바이트 집계 시험(T11.11).
// `node --test bench/proto/index.test.mjs` 로 실행한다.

import test from 'node:test';
import assert from 'node:assert';
import { createByteLedger, INITIAL_BUDGET_BYTES, SEGMENT_BUDGET_BYTES } from './index.mjs';

// SPEC S6 의 MB 는 10^6 B. 상수 자체를 손으로 쓴 리터럴로 고정한다.
test('예산 상수는 SPEC 단위(MB = 10^6 B)', () => {
  assert.equal(INITIAL_BUDGET_BYTES, 15_000_000);
  assert.equal(SEGMENT_BUDGET_BYTES, 3_000_000);
});

test('createByteLedger - 기본 기록', () => {
  const ledger = createByteLedger();

  // initial 단계 기록
  ledger.record(1000, { segmentId: 0, phase: 'initial' });
  assert.equal(ledger.initialBytes(), 1000, 'initial 바이트 1000 이어야 한다');

  // segment 단계 기록
  ledger.record(2000, { segmentId: 0, phase: 'segment' });
  const perSeg = ledger.perSegment();
  assert.equal(perSeg.get(0), 2000, '구간 0은 segment 단계의 2000 바이트만 카운트해야 한다');
});

test('createByteLedger - Uint8Array 입력', () => {
  const ledger = createByteLedger();

  const arr = new Uint8Array(5000);
  ledger.record(arr, { segmentId: 1, phase: 'segment' });

  const perSeg = ledger.perSegment();
  assert.equal(perSeg.get(1), 5000, 'Uint8Array 길이 5000 바이트로 기록되어야 한다');
});

test('createByteLedger - 여러 구간 추적', () => {
  const ledger = createByteLedger();

  ledger.record(1000, { segmentId: 0, phase: 'segment' });
  ledger.record(2000, { segmentId: 1, phase: 'segment' });
  ledger.record(3000, { segmentId: 2, phase: 'segment' });
  ledger.record(500, { segmentId: 0, phase: 'segment' });

  const perSeg = ledger.perSegment();
  assert.equal(perSeg.get(0), 1500, '구간 0은 1500 바이트');
  assert.equal(perSeg.get(1), 2000, '구간 1은 2000 바이트');
  assert.equal(perSeg.get(2), 3000, '구간 2는 3000 바이트');
  assert.equal(perSeg.size, 3, '3개 구간이어야 한다');
});

test('createByteLedger - initial 과 segment 분리', () => {
  const ledger = createByteLedger();

  // initial 단계는 segmentId 와 무관하게 누적
  ledger.record(1000, { segmentId: 0, phase: 'initial' });
  ledger.record(2000, { segmentId: 1, phase: 'initial' });
  ledger.record(3000, { segmentId: 0, phase: 'initial' });

  assert.equal(ledger.initialBytes(), 6000, 'initial 바이트는 모든 segmentId 에서 누적');

  // segment 단계는 segmentId 별로 기록
  ledger.record(5000, { segmentId: 0, phase: 'segment' });
  ledger.record(4000, { segmentId: 1, phase: 'segment' });

  const perSeg = ledger.perSegment();
  assert.equal(perSeg.get(0), 5000, '구간 0 segment 바이트는 5000');
  assert.equal(perSeg.get(1), 4000, '구간 1 segment 바이트는 4000');
});

test('overBudget - 기본값으로 예산 확인', () => {
  const ledger = createByteLedger();

  // 정상 범위: 각 구간 3 MB 미만
  ledger.record(1_000_000, { segmentId: 0, phase: 'segment' });
  ledger.record(2_000_000, { segmentId: 1, phase: 'segment' });
  ledger.record(1000, { segmentId: 0, phase: 'initial' });

  const result = ledger.overBudget();
  assert.equal(result.initial, false, 'initial 예산 내');
  assert.deepEqual(result.segments, [], '모든 구간이 예산 내');
});

test('overBudget - 경계: 정확히 3 MB(3,000,000 B) 는 통과', () => {
  const ledger = createByteLedger();

  const exactBudget = 3_000_000;
  ledger.record(exactBudget, { segmentId: 0, phase: 'segment' });

  const result = ledger.overBudget();
  assert.equal(result.initial, false, 'initial 예산 내');
  assert.deepEqual(result.segments, [], '정확히 3,000,000 B 는 예산 내(통과)');
});

test('overBudget - 경계: 3,000,001 B 는 초과', () => {
  const ledger = createByteLedger();

  const overBudget = 3_000_001;
  ledger.record(overBudget, { segmentId: 0, phase: 'segment' });

  const result = ledger.overBudget();
  assert.equal(result.initial, false, 'initial 예산 내');
  assert.deepEqual(result.segments, [0], '구간 0이 예산 초과');
});

test('overBudget - 여러 구간 초과', () => {
  const ledger = createByteLedger();

  const over = 3_000_001;
  ledger.record(over, { segmentId: 0, phase: 'segment' });
  ledger.record(over, { segmentId: 2, phase: 'segment' });
  ledger.record(2_000_000, { segmentId: 1, phase: 'segment' });  // 정상

  const result = ledger.overBudget();
  assert.deepEqual(result.segments, [0, 2], '초과한 구간이 오름차순으로 정렬됨');
});

test('overBudget - 경계: 초기 정확히 15,000,000 B 는 통과(`>` 를 `>=` 로 바꾸면 실패)', () => {
  const ledger = createByteLedger();
  ledger.record(15_000_000, { segmentId: 0, phase: 'initial' });
  assert.equal(ledger.overBudget().initial, false, '정확히 15,000,000 B 는 예산 내');
  assert.equal(ledger.initialBytes(), 15_000_000);
});

test('overBudget - 경계: 초기 15,000,000 + 1 B 는 초과(여러 번에 나눠 기록해도)', () => {
  const ledger = createByteLedger();
  ledger.record(14_999_999, { segmentId: 0, phase: 'initial' });
  assert.equal(ledger.overBudget().initial, false, '14,999,999 B 는 통과');
  ledger.record(2, { segmentId: 0, phase: 'initial' });
  assert.equal(ledger.initialBytes(), 15_000_001);
  assert.equal(ledger.overBudget().initial, true, '15,000,001 B 는 초과');
});

test('overBudget - initial 단계 초과', () => {
  const ledger = createByteLedger();

  // initial 단계: 15,000,001 B
  const overInitial = 15_000_001;
  ledger.record(overInitial, { segmentId: 0, phase: 'initial' });

  const result = ledger.overBudget();
  assert.equal(result.initial, true, 'initial 단계 예산 초과');
  assert.deepEqual(result.segments, [], 'segment 는 기록하지 않음');
});

test('overBudget - 사용자 정의 예산', () => {
  const ledger = createByteLedger();

  ledger.record(1000, { segmentId: 0, phase: 'segment' });
  ledger.record(2000, { segmentId: 0, phase: 'initial' });

  // 커스텀 예산: initial 1000, per-segment 500
  const result = ledger.overBudget({ initialMax: 1000, perSegmentMax: 500 });
  assert.equal(result.initial, true, 'initial 2000 > 1000');
  assert.deepEqual(result.segments, [0], '구간 0 1000 > 500');
});

test('overBudget - 빈 원장', () => {
  const ledger = createByteLedger();

  const result = ledger.overBudget();
  assert.equal(result.initial, false);
  assert.deepEqual(result.segments, []);
});

test('합성 데이터: 손 계산 검증', () => {
  // 구간 0: 1,000,000 + 500,000 = 1,500,000 B / 구간 1: 2,000,000 B / 구간 2: 1,500,000 B / initial: 500,000 B
  const ledger = createByteLedger();

  ledger.record(1_000_000, { segmentId: 0, phase: 'segment' });
  ledger.record(500_000, { segmentId: 0, phase: 'segment' });
  ledger.record(2_000_000, { segmentId: 1, phase: 'segment' });
  ledger.record(1_500_000, { segmentId: 2, phase: 'segment' });
  ledger.record(500_000, { segmentId: 0, phase: 'initial' });

  assert.equal(ledger.initialBytes(), 500_000);

  const perSeg = ledger.perSegment();
  assert.equal(perSeg.get(0), 1_500_000);
  assert.equal(perSeg.get(1), 2_000_000);
  assert.equal(perSeg.get(2), 1_500_000);

  const result = ledger.overBudget();
  assert.equal(result.initial, false, 'initial 예산 내');
  assert.deepEqual(result.segments, [], '모든 구간이 예산 내');
});
