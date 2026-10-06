// T13.U-2: S9-현황판 근거 점군(evaluateFlatBoxesBudget, 예산 맞춤 flat_boxes)의 배분·솎기 변이 단언(F-594 a).
// s6_quality.test.mjs 의 변이 단언은 예산을 넘는 이식 점군(evaluateThinner)에만 걸려 있어, 근거 점군 경로의 배분·솎기가
// 퇴행해도 못 잡는다. 이 파일은 같은 경로(320x180·8시점·250만 점·flat_boxes 시드 1, 최고 수준 3)에서 변이 둘을 직접 잰다.
//   (i) 배분만 원본 비례(levelPointTargets)로 되돌림, 솎기는 채택안(블루노이즈) 그대로.
//   (ii) 솎기만 모턴 등간격(createSpatialThinner)으로 되돌림, 배분은 채택안 그대로.
//   (i)+(ii) 동시 되돌림은 이전 채택안이고 그 최소 SSIM 0.5974 를 사실로 고정한다.
// 문턱의 근거(측정값에 사후로 맞추지 않는다): flat_boxes 시드 1..6 에서 위 네 구성의 최소 SSIM 을 쟀다.
//   채택안 최소 SSIM 의 시드 간 평균 0.7423, 표본 표준편차 0.0304 이지만 이 산포는 장면 난이도(시드마다 점 배치가 다름)에서
//   오고 변이 구성도 같은 만큼 같이 움직인다. 변이 효과의 잡음은 같은 시드 안의 짝 차이(채택안 − 변이)의 시드 간 산포다.
//   그 표본 표준편차 σ 로 문턱 = 2σ 를 쓴다(아래 SEED_DIFFS 에서 시험이 직접 계산). 차이가 문턱 이상이면 시드를 바꿔도 우연한 흔들림이 아니다.
// 시드별 짝 차이(채택안 − 변이, 시드 1..6):
const SEED_DIFFS = {
  thin: [0.0186, 0.0306, 0.0228, 0.0279, 0.0373, 0.0239], // 솎기만 모턴 등간격: 평균 0.0269, σ 0.0066 → 문턱 0.0132
  alloc: [0.0793, 0.0886, 0.0665, 0.0890, 0.0989, 0.0641], // 배분만 원본 비례: 평균 0.0811, σ 0.0137 → 문턱 0.0275
};
// 시험 시간: 4구성(수준 3 만 그림). `node --test bench/status_quality/s6_fb_mutation.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFlatBoxesBudget } from './tune.mjs';
import { levelPointTargets, createSpatialThinner } from '../../server/scheduler/segment_budget/index.mjs';

const S6_BYTES = 3_000_000;
const BASE_MIN_SSIM = 0.7579; // 채택안(예산 맞춤 flat_boxes, 시드 1) 최소 SSIM, 구간 2,949,851 B
const PREV_MIN_SSIM = 0.5974; // 이전 채택안(원본 비례 배분 + 모턴 등간격) 최소 SSIM
const K = 2;
const f4 = (x) => x.toFixed(4);
const sigma = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const THRESH = { thin: K * sigma(SEED_DIFFS.thin), alloc: K * sigma(SEED_DIFFS.alloc) };

const opts = { count: 2500000, sceneSeed: 1, levels: [3] };
const top = (x) => x.levels[0];
const base = await evaluateFlatBoxesBudget(opts);
const mutAlloc = await evaluateFlatBoxesBudget({ ...opts, allocate: levelPointTargets });
const mutThin = await evaluateFlatBoxesBudget({ ...opts, createThinner: createSpatialThinner });
const prev = await evaluateFlatBoxesBudget({ ...opts, allocate: levelPointTargets, createThinner: createSpatialThinner });

test('채택안 고정: 최소 SSIM 0.7579(±0.0005), 구간 ≤ 3,000,000 B', (t) => {
  t.diagnostic(`채택안 ${f4(top(base).ssimMin)}, ${base.bytes} B, 점 ${base.levelPoints.join('/')}`);
  assert.ok(Math.abs(top(base).ssimMin - BASE_MIN_SSIM) <= 0.0005, `${top(base).ssimMin}`);
  assert.ok(base.thinned && base.bytes <= S6_BYTES);
});

test('변이 (i): 배분만 원본 비례로 되돌리면 최소 SSIM 이 2σ(시드 짝 차이) 이상 낮다', (t) => {
  const d = top(base).ssimMin - top(mutAlloc).ssimMin;
  t.diagnostic(`배분 변이 ${f4(top(mutAlloc).ssimMin)}, 차이 ${f4(d)}, 문턱 ${f4(THRESH.alloc)}, 점 ${mutAlloc.levelPoints.join('/')}, ${mutAlloc.bytes} B`);
  assert.ok(mutAlloc.bytes <= S6_BYTES);
  assert.ok(d >= THRESH.alloc, `차이 ${d} < 문턱 ${THRESH.alloc}`);
});

test('변이 (ii): 솎기만 모턴 등간격으로 되돌리면 최소 SSIM 이 2σ(시드 짝 차이) 이상 낮다', (t) => {
  const d = top(base).ssimMin - top(mutThin).ssimMin;
  t.diagnostic(`솎기 변이 ${f4(top(mutThin).ssimMin)}, 차이 ${f4(d)}, 문턱 ${f4(THRESH.thin)}, 점 ${mutThin.levelPoints.join('/')}, ${mutThin.bytes} B`);
  assert.ok(mutThin.bytes <= S6_BYTES);
  assert.ok(d >= THRESH.thin, `차이 ${d} < 문턱 ${THRESH.thin}`);
});

test('이전 채택안(배분·솎기 둘 다 되돌림) 최소 SSIM 0.5974 고정', (t) => {
  t.diagnostic(`이전 채택안 ${f4(top(prev).ssimMin)}, ${prev.bytes} B`);
  assert.ok(Math.abs(top(prev).ssimMin - PREV_MIN_SSIM) <= 0.0005, `${top(prev).ssimMin}`);
  assert.ok(prev.bytes <= S6_BYTES);
});

test('문턱 자체의 타당성: 시드 6조 모두에서 짝 차이가 양수이고 문턱은 시드 평균 차이보다 낮다', () => {
  for (const key of ['thin', 'alloc']) {
    assert.ok(SEED_DIFFS[key].every((d) => d > 0));
    assert.ok(THRESH[key] < SEED_DIFFS[key].reduce((s, x) => s + x, 0) / SEED_DIFFS[key].length);
  }
});
