// 현황판 경로 대역폭 문턱 시험(T13.9). SPEC §4 S6: 초기 ≤ 15 MB, 구간당 ≤ 3 MB. 문턱은 SPEC 수치 그대로(contracts/statusview).
// `node --test bench/status_bw/status_bw.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_BANDWIDTH_LIMITS } from '../../contracts/statusview/index.mjs';
import { measureStatusBandwidth } from './index.mjs';

test('문턱 값이 SPEC S6 수치 그대로다', () => {
  assert.equal(STATUS_BANDWIDTH_LIMITS.initialBytes, 15 * 1024 * 1024);
  assert.equal(STATUS_BANDWIDTH_LIMITS.perSegmentBytes, 3 * 1024 * 1024);
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

test('합성 장면(구간 4 개, 구간당 최고 수준 10만 점): 초기·구간당이 문턱 이하', () => {
  assert.ok(small.initialBytes <= STATUS_BANDWIDTH_LIMITS.initialBytes, `초기 ${small.initialBytes}`);
  for (const r of small.rows) assert.ok(r.frameBytes <= STATUS_BANDWIDTH_LIMITS.perSegmentBytes, `구간 ${r.segmentId} ${r.frameBytes}`);
});

// 구간당 약 250만 점 규모(SPEC S6 이 가정하는 규모). 문턱을 넘으면 실패 그대로 둔다.
const large = measureStatusBandwidth({ segments: 3, pointsPerSegment: 2500000 });

test('구간당 250만 점 합성: 초기가 문턱 이하', () => {
  assert.ok(large.initialBytes <= STATUS_BANDWIDTH_LIMITS.initialBytes, `초기 ${large.initialBytes}`);
});

test('구간당 250만 점 합성: 구간당 바이트가 문턱 이하', () => {
  for (const r of large.rows) assert.ok(r.frameBytes <= STATUS_BANDWIDTH_LIMITS.perSegmentBytes, `구간 ${r.segmentId} ${r.frameBytes} > ${STATUS_BANDWIDTH_LIMITS.perSegmentBytes}`);
});
