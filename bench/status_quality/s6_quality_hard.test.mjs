// T13.HQ 어려운 변형: S6 송출 구성(원본 점 전부, 무손실 codec 1, 솎기·구간 바이트 예산 없음)의 현황판 8시점 SSIM 을
// flat_boxes 밖의 장면 depth_noise(깊이 잡음)·buildings(건물 외곽)에서 단언한다. 문턱은 SPEC 현황판 수치 0.95 이고
// 이 파일 안의 숫자 리터럴이며 측정값에 맞춰 바꾸지 않는다. 구간 바이트는 출력만 한다(문턱 없음).
// 측정 경로는 s6_quality.test.mjs 와 같다(컬링+LOD 선택 → 64 m 타일 조각 → codec 1 → 클라이언트 복호 → CPU 참조 래스터러, 320x180).
// 장면별 고정 시점 8곳과 점 수 상한은 variants.mjs 에 있다.
//   depth_noise: 250만 점(SPEC 규모). 자식 하나가 3 개 동시 실행에서 약 160~190 s 걸려 기본은 시드 1·2 만 단언하고,
//   buildings: 생성기가 건물마다 지붕 점 1개만 내고 건물 수 상한이 49,284(밑면 8 m 제약)라 그 최대 점 수로 잰다. 시드 1..6 모두 단언.
// 시드마다 별도 자식 프로세스(tune_cli.mjs, 인자 [점수, 시드, 변형])를 run_seeds.mjs 의 runSeeds 로 병렬 실행한다.
// `node --test bench/status_quality/s6_quality_hard.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runSeeds } from './run_seeds.mjs';
import { evaluateFullSend } from './tune.mjs';
import { BUILDINGS_MAX_COUNT, DEPTH_NOISE_VIEWPOINTS, BUILDINGS_VIEWPOINTS } from './variants.mjs';

const CLI = fileURLToPath(new URL('./tune_cli.mjs', import.meta.url));
const ALL_SEEDS = [1, 2, 3, 4, 5, 6];
const RUNS = [
  { variant: 'depth_noise', count: 2500000, seeds: ALL_SEEDS, levelPoints: [312500, 625000, 1250000, 2500000] },
  { variant: 'buildings', count: BUILDINGS_MAX_COUNT, seeds: ALL_SEEDS, levelPoints: [6160, 12321, 24642, 49284] },
];

test('variant 는 flat_boxes|depth_noise|buildings 만 받고 나머지는 RangeError', async () => {
  await assert.rejects(evaluateFullSend({ count: 1000, variant: 'holes', bwOnly: true }), RangeError);
  await assert.rejects(evaluateFullSend({ count: 1000, variant: '', bwOnly: true }), RangeError);
});

test('변형 장면은 고정 시점 8곳, buildings 는 49,284 점이 상한(그보다 크면 생성기가 던진다)', async () => {
  assert.equal(DEPTH_NOISE_VIEWPOINTS.length, 8);
  assert.equal(BUILDINGS_VIEWPOINTS.length, 8);
  assert.equal(BUILDINGS_MAX_COUNT, 49284);
  await assert.rejects(evaluateFullSend({ count: 49285, variant: 'buildings', bwOnly: true }), /밑면 8 m/);
});

// 변형마다 차례로 돌린다(자식당 RSS 약 0.6 GB, 동시 수는 runSeeds 기본값 = 코어 수와 3 중 작은 값).
const results = new Map();
for (const r of RUNS) {
  try {
    results.set(r.variant, await runSeeds({ cli: CLI, argsFor: (seed) => [String(r.count), String(seed), r.variant], seeds: r.seeds }));
  } catch (e) {
    results.set(r.variant, e);
  }
}

for (const r of RUNS) {
  test(`${r.variant}: 시드별 최소 SSIM 표`, (t) => {
    const m = results.get(r.variant);
    if (m instanceof Error) throw m;
    t.diagnostic(`${r.variant} | 점 ${r.count} | ${r.seeds.map((s) => `시드 ${s} 최소 ${m.get(s).ssimMin} 평균 ${m.get(s).ssimMean}`).join(' | ')}`);
  });
  for (const seed of r.seeds) {
    test(`${r.variant} 시드 ${seed}: 원본 점 전부(${r.count} 점) 송출, 8시점 최소 SSIM ≥ 0.95`, (t) => {
      const m = results.get(r.variant);
      if (m instanceof Error) throw m;
      const x = m.get(seed);
      t.diagnostic(`구간 ${x.bytes} B (수준별 ${x.levelBytes.join('/')} B, 출력 전용), 수준별 점 ${x.levelPoints.join('/')}, 최소 SSIM ${x.ssimMin}, 평균 ${x.ssimMean}`);
      assert.deepEqual(x.levelPoints, r.levelPoints);
      assert.equal(x.ssims.length, 8);
      assert.ok(x.ssimMin >= 0.95, `${r.variant} 시드 ${seed} 최소 SSIM ${x.ssimMin} (시점별 ${x.ssims.join(', ')})`);
    });
  }
}
