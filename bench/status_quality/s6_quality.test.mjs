// T13.T: S6 송출 구성에서 구간 바이트와 현황판 8시점 SSIM 을 같은 구성으로 함께 단언한다(SPEC §4.1, 결정 0065).
// S6 구간당 문턱 3,000,000 B 는 SPEC 수치 그대로고, S9-현황판 값을 감독이 2026-10-06 SPEC §4.1 로 0.75 고정했다.
// 최고 수준 도착 전(수준 0..2 만 있는 화면)의 SSIM 은 진단으로만 출력한다(SPEC 에 문턱 없음).
// 측정 경로: 구간당 250만 점 합성, CPU 참조 래스터러(WebGL 제외), 장면 flat_boxes 시드 1·320x180·8시점.
// 두 방식으로 잰다: (가) levels 장면에서 예산에 맞춘 최고 수준 비율을 flat_boxes 에 이식(연구 결과 D 방식, 바이트와 SSIM 의 점군이 다르다),
// (나) flat_boxes 자체를 4수준으로 만들어 예산에 맞춘 점군(바이트와 SSIM 이 같은 점군). SSIM 은 정상 상태(최고 수준 도착 후) 기준이고,
// 최고 수준 도착 전(수준 0..2 만 있는 화면)의 SSIM 은 진단으로만 출력한다(SPEC 에 문턱 없음).
// 약 115 s(측정 5회: 이식 3회, flat_boxes 예산 맞춤 2회). `node --test bench/status_quality/s6_quality.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateThinner, evaluateFlatBoxesBudget } from './tune.mjs';
import { levelPointTargets, createSpatialThinner } from '../../server/scheduler/segment_budget/index.mjs';

const S6_BYTES = 3_000_000;
const MIN_SSIM = 0.75;
const f4 = (x) => x.toFixed(4);

const r = await evaluateThinner({ count: 2500000 });
const fb = await evaluateFlatBoxesBudget({ count: 2500000 });

test('S6 구성 한 번의 측정(levels 비율 이식): 구간 ≤ 3,000,000 B 이고 8시점 최소 SSIM ≥ 0.65', (t) => {
  t.diagnostic(`구간 ${r.bytes} B, 수준별 점 ${r.levelPoints.join('/')}, 최고 수준 비율 ${r.ratio.toFixed(5)}, 최소 SSIM ${f4(r.ssimMin)}, 평균 ${f4(r.ssimMean)}`);
  // 바이트는 levels 장면 구간의 것이다. SSIM 을 잰 flat_boxes 점군 자체를 같은 S6 경로로 보내면 바이트가 다르다(예산 단언 대상 아님).
  t.diagnostic(`SSIM 대상 점군(flat_boxes 최고 수준 ${r.ssimTargetPoints} 점)의 S6 경로 바이트 ${r.ssimTargetBytes} B (최고 수준 하나만, 예산 ${S6_BYTES} B)`);
  assert.equal(r.ssims.length, 8);
  assert.ok(r.bytes <= S6_BYTES, `구간 ${r.bytes} B`);
  assert.ok(r.bytes >= 0.95 * S6_BYTES, `구간 ${r.bytes} B 가 예산의 95% 미만(예산을 못 채움)`);
  assert.ok(r.ssimMin >= MIN_SSIM, `최소 SSIM ${r.ssimMin}`);
});

test('flat_boxes 예산 맞춤: SSIM 을 잰 점군 자체의 4수준 S6 경로 바이트 ≤ 3,000,000 B 이고 최고 수준 8시점 최소 SSIM ≥ 0.65', (t) => {
  const top = fb.levels.find((l) => l.level === 3);
  t.diagnostic(`flat_boxes 예산 맞춤: 구간 ${fb.bytes} B (수준별 ${fb.levelBytes.join('/')} B), 수준별 점 ${fb.levelPoints.join('/')}, 최소 SSIM ${f4(top.ssimMin)}, 평균 ${f4(top.ssimMean)}`);
  t.diagnostic(`최소 SSIM 두 값: levels 비율 이식 ${f4(r.ssimMin)}, flat_boxes 예산 맞춤 ${f4(top.ssimMin)}, 낮은 쪽 ${f4(Math.min(r.ssimMin, top.ssimMin))}`);
  assert.equal(top.ssims.length, 8);
  assert.ok(fb.thinned);
  assert.ok(fb.bytes <= S6_BYTES, `구간 ${fb.bytes} B`);
  assert.ok(fb.bytes >= 0.95 * S6_BYTES, `구간 ${fb.bytes} B 가 예산의 95% 미만(예산을 못 채움)`);
  assert.ok(top.ssimMin >= MIN_SSIM, `최소 SSIM ${top.ssimMin}`);
});

test('낮은 수준 보장: 수준 0..2 는 원본의 2% 이상, 수준마다 점 수 엄격 증가', () => {
  for (const x of [r, fb]) {
    assert.deepEqual(x.levelSource, [312500, 625000, 1250000, 2500000]);
    for (let k = 0; k < 3; k++) assert.ok(x.levelPoints[k] >= Math.floor(0.02 * x.levelSource[k]), `수준 ${k} ${x.levelPoints[k]}`);
    for (let k = 1; k < 4; k++) assert.ok(x.levelPoints[k] > x.levelPoints[k - 1]);
  }
});

test('진단: 수준별로 그 수준만 그린 8시점 SSIM(flat_boxes 예산 맞춤), 채택안 대 이전 채택안(원본 비례 배분 + 모턴 등간격)', async (t) => {
  // SPEC 에 최고 수준 도착 전 화면의 문턱이 없어 단언하지 않는다(사람 판단 자료).
  const prev = await evaluateFlatBoxesBudget({ count: 2500000, allocate: levelPointTargets, createThinner: createSpatialThinner });
  t.diagnostic(`이전 채택안 구간 ${prev.bytes} B, 수준별 점 ${prev.levelPoints.join('/')}`);
  t.diagnostic('수준 | 채택안 점 | 채택안 최소/평균 SSIM | 이전 점 | 이전 최소/평균 SSIM');
  for (let i = 0; i < fb.levels.length; i++) {
    const a = fb.levels[i], b = prev.levels[i];
    t.diagnostic(`${a.level} | ${a.points} | ${f4(a.ssimMin)}/${f4(a.ssimMean)} | ${b.points} | ${f4(b.ssimMin)}/${f4(b.ssimMean)}`);
  }
  assert.ok(prev.bytes <= S6_BYTES);
});

// 변이 문턱의 근거. 이 시험은 결정적이라(같은 시드면 같은 값) 문턱은 장면이 달라져도 개선이 남는지를 보는 여유다.
// 시드 6조(levels 시드 1·flat_boxes 시드 1..4, levels 시드 2·3·flat_boxes 시드 1)에서 잰 최소 SSIM 차이(채택안 − 변이):
//   솎기만 모턴 등간격: 0.0250 0.0244 0.0200 0.0281 0.0281 0.0302, 평균 0.0260, 표본 표준편차 0.0036 → 평균 − 3σ = 0.0150.
//     기본 시드(1·1)의 실측 차이는 0.0250 이고, 문턱 0.015 는 시드 분산의 3σ 아래 끝이다(관측 최솟값 0.0200).
//   배분만 원본 비례: 0.0864 0.0916 0.0780 0.0969 0.0895 0.0860, 평균 0.0881, 표준편차 0.0063 → 평균 − 3σ = 0.0691 이라 문턱 0.05 는 그 아래다.
//   참고로 이전 채택안 전체(배분 + 솎기 둘 다 되돌림)의 차이는 0.1001..0.1262 다.
test('변이: 솎기를 모턴 등간격으로 되돌리면 최소 SSIM 이 이 구성보다 0.015 이상 낮다', async (t) => {
  const m = await evaluateThinner({ count: 2500000, createThinner: createSpatialThinner });
  t.diagnostic(`모턴 등간격 최소 SSIM ${f4(m.ssimMin)}, 차이 ${f4(r.ssimMin - m.ssimMin)}`);
  assert.ok(m.bytes <= S6_BYTES);
  assert.ok(r.ssimMin - m.ssimMin >= 0.015, `개선 ${r.ssimMin - m.ssimMin} (모턴 등간격 ${m.ssimMin})`);
});

test('변이: 배분만 원본 비례로 되돌리면(솎기는 블루노이즈 그대로) 최소 SSIM 이 이 구성보다 0.05 이상 낮다', async (t) => {
  const base = await evaluateThinner({ count: 2500000, allocate: levelPointTargets });
  t.diagnostic(`원본 비례 배분 최소 SSIM ${f4(base.ssimMin)}, 차이 ${f4(r.ssimMin - base.ssimMin)}`);
  assert.ok(base.bytes <= S6_BYTES);
  assert.ok(r.ssimMin - base.ssimMin >= 0.05, `개선 ${r.ssimMin - base.ssimMin} (원본 비례 배분 ${base.ssimMin})`);
});
