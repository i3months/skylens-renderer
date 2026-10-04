// 현황판 경로 대역폭 문턱 시험(T13.9). SPEC §4 S6: 초기 ≤ 15 MB, 구간당 ≤ 3 MB (MB = 10^6 B).
// 문턱은 계약 파일과 무관하게 이 시험 안에 리터럴로 박는다.
// `node --test bench/status_bw/status_bw.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createByteLedger } from '../proto/index.mjs';
import { measureStatusBandwidth, STATUS_BW_LIMITS } from './index.mjs';

const INITIAL_LIMIT = 15_000_000;
const SEGMENT_LIMIT = 3_000_000;
// 250만 점 규모 현재값 회귀 상한(S6 통과 기준이 아니다).
const LARGE_SEGMENT_REGRESSION_CAP = 53_000_000;

test('문턱 값이 SPEC S6 수치(10^6 B 기준) 그대로다', () => {
  assert.equal(STATUS_BW_LIMITS.initialBytes, 15_000_000);
  assert.equal(STATUS_BW_LIMITS.perSegmentBytes, 3_000_000);
});

test('구간 바이트 3_000_001 은 초과, 3_000_000 은 통과로 판정된다', () => {
  const over = createByteLedger();
  over.record(3_000_001, { segmentId: 7, phase: 'segment' });
  assert.deepEqual(over.overBudget({ initialMax: STATUS_BW_LIMITS.initialBytes, perSegmentMax: STATUS_BW_LIMITS.perSegmentBytes }).segments, [7]);
  const ok = createByteLedger();
  ok.record(3_000_000, { segmentId: 7, phase: 'segment' });
  assert.deepEqual(ok.overBudget({ initialMax: STATUS_BW_LIMITS.initialBytes, perSegmentMax: STATUS_BW_LIMITS.perSegmentBytes }).segments, []);
});

test('initialBytes 경계값 15_000_001 은 초과, 15_000_000 은 통과로 판정된다', () => {
  const over = createByteLedger();
  over.record(15_000_001, { segmentId: 0, phase: 'initial' });
  assert.deepEqual(over.overBudget({ initialMax: STATUS_BW_LIMITS.initialBytes }).initial, true);
  const ok = createByteLedger();
  ok.record(15_000_000, { segmentId: 0, phase: 'initial' });
  assert.deepEqual(ok.overBudget({ initialMax: STATUS_BW_LIMITS.initialBytes }).initial, false);
});

const small = measureStatusBandwidth({ segments: 4, pointsPerSegment: 100000 });

test('측정 구조: 구간 4 개, 수준 4 개, 점 수는 수준마다 엄격 증가, 초기 = WELCOME + 구간 0 수준 0', () => {
  assert.equal(small.rows.length, 4);
  for (const r of small.rows) {
    assert.deepEqual(r.levels.map((l) => l.points), [12500, 25000, 50000, 100000]);
    assert.equal(r.frameBytes, r.levels.reduce((s, l) => s + l.frameBytes, 0));
    // LEVEL_ARRIVED 프레임: ws 머리 2 + 프레임 머리 8 + 본문 13
    for (const l of r.levels) assert.equal(l.arrivedBytes, 23);
  }
  assert.equal(small.welcomeBytes, 19);
  assert.equal(small.initialBytes, 19 + small.rows[0].levels[0].frameBytes);
});

test('10만 점 합성(SPEC 규모 아님 — S6 충족을 뜻하지 않음): 초기·구간당이 문턱 이하', () => {
  assert.ok(small.initialBytes <= INITIAL_LIMIT, `초기 ${small.initialBytes}`);
  for (const r of small.rows) assert.ok(r.frameBytes <= SEGMENT_LIMIT, `구간 ${r.segmentId} ${r.frameBytes}`);
});

// 구간당 약 250만 점 규모(SPEC S6 이 가정하는 규모).
const large = measureStatusBandwidth({ segments: 3, pointsPerSegment: 2500000 });

test('구간당 250만 점 합성: 초기가 문턱 이하', () => {
  assert.ok(large.initialBytes <= INITIAL_LIMIT, `초기 ${large.initialBytes}`);
});

// 현재값 회귀 상한 시험이며 S6 통과 단언이 아니다. 이 규모에서 구간당 바이트는 문턱(3_000_000)을 크게 넘는다(측정 약 51.6 MB).
// 압축률·송출 구성이 나빠지면 잡기 위한 상한일 뿐이다. S6 구간당 통과(≤ 3_000_000 B) 단언은 T13.B 몫이다.
// 문턱 대비 배율은 계속 출력한다.
test('구간당 250만 점 합성: 현재값 회귀 상한(S6 통과 단언 아님)', () => {
  for (const r of large.rows) {
    const ratio = r.frameBytes / SEGMENT_LIMIT;
    console.log(`# 구간 ${r.segmentId}: ${r.frameBytes} B = S6 문턱의 ${ratio.toFixed(1)} 배(미달)`);
    assert.ok(r.frameBytes <= LARGE_SEGMENT_REGRESSION_CAP, `구간 ${r.segmentId} ${r.frameBytes}`);
  }
});
