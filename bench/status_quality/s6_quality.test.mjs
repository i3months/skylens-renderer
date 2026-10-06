// T13.T: S6 송출 구성에서 구간 바이트와 현황판 8시점 SSIM 을 같은 구성으로 함께 단언한다(SPEC §4.1, 결정 0065).
// S6 구간당 문턱 3,000,000 B 는 SPEC 수치 그대로고, S9-현황판 임시 하한 0.65 는 사람 결정(2026-10-06)의 하한이다.
// 감독이 S9-현황판 값을 고정하면 이 파일의 0.65 를 그 값으로 올린다(낮추지 않는다).
// 측정 경로: 구간당 250만 점 합성, CPU 참조 래스터러(WebGL 제외), 장면 flat_boxes 시드 1·320x180·8시점. 약 60 s(변이 시험 2회 포함).
// `node --test bench/status_quality/s6_quality.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateThinner } from './tune.mjs';
import { levelPointTargets, createSpatialThinner } from '../../server/scheduler/segment_budget/index.mjs';

const S6_BYTES = 3_000_000;
const MIN_SSIM = 0.65;

const r = await evaluateThinner({ count: 2500000 });

test('S6 구성 한 번의 측정: 구간 ≤ 3,000,000 B 이고 8시점 최소 SSIM ≥ 0.65', (t) => {
  t.diagnostic(`구간 ${r.bytes} B, 수준별 점 ${r.levelPoints.join('/')}, 최고 수준 비율 ${r.ratio.toFixed(5)}, 최소 SSIM ${r.ssimMin.toFixed(4)}, 평균 ${r.ssimMean.toFixed(4)}`);
  assert.equal(r.ssims.length, 8);
  assert.ok(r.bytes <= S6_BYTES, `구간 ${r.bytes} B`);
  assert.ok(r.bytes >= 0.95 * S6_BYTES, `구간 ${r.bytes} B 가 예산의 95% 미만(예산을 못 채움)`);
  assert.ok(r.ssimMin >= MIN_SSIM, `최소 SSIM ${r.ssimMin}`);
});

test('낮은 수준 보장: 수준 0..2 는 원본의 2% 이상, 수준마다 점 수 엄격 증가', () => {
  assert.deepEqual(r.levelSource, [312500, 625000, 1250000, 2500000]);
  for (let k = 0; k < 3; k++) assert.ok(r.levelPoints[k] >= Math.floor(0.02 * r.levelSource[k]), `수준 ${k} ${r.levelPoints[k]}`);
  for (let k = 1; k < 4; k++) assert.ok(r.levelPoints[k] > r.levelPoints[k - 1]);
});

test('변이: 솎기를 모턴 등간격으로 되돌리면 최소 SSIM 이 이 구성보다 0.015 이상 낮다', async () => {
  const m = await evaluateThinner({ count: 2500000, createThinner: createSpatialThinner });
  assert.ok(m.bytes <= S6_BYTES);
  assert.ok(r.ssimMin - m.ssimMin >= 0.015, `개선 ${r.ssimMin - m.ssimMin} (모턴 등간격 ${m.ssimMin})`);
});

test('변이: 배분을 원본 비례(이전 채택안)로 되돌리면 최소 SSIM 이 이 구성보다 0.05 이상 낮다', async () => {
  const base = await evaluateThinner({ count: 2500000, allocate: levelPointTargets, createThinner: createSpatialThinner });
  assert.ok(base.bytes <= S6_BYTES);
  assert.ok(r.ssimMin - base.ssimMin >= 0.05, `개선 ${r.ssimMin - base.ssimMin} (이전 ${base.ssimMin})`);
});
