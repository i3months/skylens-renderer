// T07.4 단계 선택 시험(거친 단계 포함). select.test.mjs 의 고정 시점 8곳은 선택이 전부 단계 0 이라 거친 단계(level ≥ 1)를
// 검증하지 못한다. 여기서는 거친 단계가 실제로 쓰이는 조건에서 시점마다
//   (a) level ≥ 1 리프의 점이 선택에 실제로 있고, 8곳 평균 점 비율 ≤ 0.6
//   (b) 참조 래스터라이저로 원본 대비 SSIM ≥ 0.95 (기준을 낮추지 않는다)
// 를 단언한다. 시드 1~4 모두에서 시드별 최소 SSIM ≥ 0.95 를 단언한다(F-096).
//
// 장면: fixtures/scenes/terrain (시드 1, 점 20만). 200 m × 200 m 평면 투영 넓이 A = 40000 m² 에 균일 난수로 뿌린다.
//   색은 높이 음영 + 4 m 체크 무늬 + ±4% 잡음이라 매끄럽다(0.5 m 잡음 칸이 있는 flat_boxes 와 다름).
//
// 고정 파라미터와 근거(사후에 시점별로 맞추지 않음):
//   s0 = √(A/N) = √0.2 ≈ 0.447 m  원본 평균 점 간격(경사 ≤ 15° 라 표면적은 A 의 3.5% 이내로 더 크다).
//   EDGE0_M = s0/2 ≈ 0.224        단계 0 칸을 점 간격 이하로 둔다. 그러면 단계 1 칸(= s0) 이 원본 간격과 같고,
//                                 단계 2 칸(2·s0) 부터 칸당 약 4 점이 1 점으로 줄어든다. edge0M = s0 로 두면 같은 τ·f 에서
//                                 단계 1 이 2 배 먼 거리부터 쓰여 고정 시점에서 거친 단계가 적게 쓰인다(아래 측정표).
//   THRESHOLD_PX = 0.5            τ. select.test.mjs 와 같은 나이퀴스트 근거: 고른 단계의 칸이 화면에서 반 픽셀 이하면
//                                 모든 픽셀이 적어도 한 칸을 통째로 품으므로 대표점이 칸 안 어디에 있든 빈 픽셀이 생기지 않는다.
//   POINT_SIZE_M = 0.75           원본·LOD 모두 같은 고정값. √2·s0 ≈ 0.63 m(원본 간격의 대각) 이상이라 원본 표면에 구멍이 적다.
//                                 단계에 따라 키우지 않는 이유: τ ≤ 0.5 px 이면 고른 칸이 이미 반 픽셀 이하라 최소 1 픽셀 원판으로
//                                 덮이고, LOD 쪽만 키우면 렌더 설정이 달라져 비교가 불공정해진다(점 집합만 다르게 둔다).
//   해상도 320×180, 세로 화각 90° → fx = fy = 90 px.
//                                 거리표 규칙상 단계 l 은 d ≥ f·edge0M·2^l/τ 부터 쓰인다. 즉 f 가 작을수록(넓은 화각·낮은 해상도)
//                                 거리 임계가 작아진다(f 가 크면 임계가 커져 거친 단계가 덜 쓰인다). fx = 90 이면
//                                 단계 1 은 d ≥ 40 m, 단계 2 는 d ≥ 80 m, 단계 3 은 d ≥ 161 m 이므로 높이 30~150 m 시점에서
//                                 단계 1~3 이 쓰인다. 1280×720·화각 50°(fx ≈ 772) 이면 단계 1 도 d ≥ 345 m 라 지형(대각 283 m)
//                                 안에서는 거의 쓰이지 않는다.
//   LEVEL_COUNT = 6, MAX_LEAF = 2048.
//
// 측정표(시점 8곳, 같은 시점·같은 점 크기 0.75 m, 320×180):
//   통과(단언): 화각 90°, edge0M 0.224, τ 0.5 → SSIM 최소 0.952(inside_100), 평균 점 비율 0.469, 최대 단계 2~3.
//   통과하나 (a) 미달: 화각 90°, edge0M 0.447(= s0), τ 0.5 → SSIM 최소 0.984, 평균 점 비율 0.629(> 0.6), 최대 단계 1~2.
//   통과하나 거친 단계 미사용: 화각 50°(fx 193), edge0M 0.224, τ 0.5 → SSIM 최소 0.974, 평균 점 비율 0.750, 최대 단계 0~1.
//   실패(단언하지 않음): 화각 90°, edge0M 0.224, τ 1 → 평균 점 비율 0.190, 최대 단계 3~4, SSIM
//     0.876 / 0.974 / 0.874 / 0.922 / 0.987 / 0.961 / 0.955 / 0.799 (시점 1~8 순). 칸이 화면에서 1 픽셀까지 커지면
//     대표점 위치에 따라 픽셀이 비거나 이웃 칸 점이 그 픽셀을 차지해 체크 무늬 경계·음영이 흔들린다(나이퀴스트 조건 위반).
//   따라서 통과하는 가장 약한(가장 많이 줄이는) 조건은 τ 0.5 이며, τ 1 은 실패 조건으로 기록만 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { ssim } from '../../metrics/ssim/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { buildHierarchy, selectLevels, materialize } from './index.mjs';

const N = 200000;
const S0_M = Math.sqrt((200 * 200) / N);
const EDGE0_M = S0_M / 2;
const THRESHOLD_PX = 0.5;
const POINT_SIZE_M = 0.75;
const W = 320;
const H = 180;
const FOV_Y_DEG = 90;
const LEVEL_COUNT = 6;
const MAX_LEAF = 2048;
const SSIM_MIN = 0.95;
const MEAN_RATIO_MAX = 0.6;

// terrain 용 고정 시점 8곳(높이 30~150 m, 여러 방향·원근). 지형 높이는 1~29 m, 범위 x,z ∈ [−100, 100].
const VP = [
  { name: 'top_down_150', eye: [0, 150, 0.01], target: [0, 15, 0] },
  { name: 'oblique_sw_120', eye: [-140, 120, -140], target: [0, 15, 0] },
  { name: 'east_90', eye: [140, 90, 0], target: [-20, 15, 0] },
  { name: 'south_60', eye: [0, 60, 140], target: [0, 15, 0] },
  { name: 'low_ne_30', eye: [100, 30, 100], target: [0, 15, -30] },
  { name: 'west_45', eye: [-120, 45, 60], target: [40, 10, -20] },
  { name: 'far_north_150', eye: [60, 150, -160], target: [0, 15, 20] },
  { name: 'inside_100', eye: [-50, 100, -50], target: [50, 10, 50] },
];

// 시드별 최소 SSIM 측정값(리터럴 기록, 시점 8곳 중 최소, 항상 inside_100). 기준 SSIM_MIN 0.95 는 그대로이고
// 아래 단언은 기준만 쓴다(측정값은 참고용 진단 출력에만 쓰며 사후 기준 조정에 쓰지 않는다).
const MEASURED_MIN_SSIM = { 1: 0.9842, 2: 0.9825, 3: 0.9839, 4: 0.9835 };
const SEEDS = [1, 2, 3, 4];

const cache = new Map();
function scene(seed = 1) {
  if (!cache.has(seed)) {
    const { cloud } = generate({ seed, count: N });
    cache.set(seed, { cloud, h: buildHierarchy(cloud, { edge0M: EDGE0_M, levelCount: LEVEL_COUNT, maxLeafPoints: MAX_LEAF }) });
  }
  return cache.get(seed);
}

// 선택에서 단계 ≥ 1 리프의 점 수와 최대 단계
function coarseStats(h, sel) {
  let coarsePts = 0, maxLevel = 0;
  for (let k = 0; k < sel.leafLevel.length; k++) {
    const l = sel.leafLevel[k];
    if (l === NOT_DRAWN) continue;
    if (l > maxLevel) maxLevel = l;
    if (l >= 1) coarsePts += h.levels[l].leafStart[k + 1] - h.levels[l].leafStart[k];
  }
  return { coarsePts, maxLevel };
}
// 단계 선택을 0 으로 고정한 가짜 선택(시야 밖 판정은 유지)
function forceLevel0(h, sel) {
  const leafLevel = Uint8Array.from(sel.leafLevel, (l) => (l === NOT_DRAWN ? NOT_DRAWN : 0));
  let pointCount = 0;
  for (let k = 0; k < leafLevel.length; k++) if (leafLevel[k] !== NOT_DRAWN) pointCount += h.levels[0].leafStart[k + 1] - h.levels[0].leafStart[k];
  return { leafLevel, pointCount };
}
const camOf = (vp) => viewpointToCamera({ eye: vp.eye, target: vp.target, up: [0, 1, 0], width: W, height: H, fov_y_deg: FOV_Y_DEG });

const ratios = [];
const table = [];

test('terrain 시점 8곳', () => {
  assert.equal(VP.length, 8);
});

for (const seed of SEEDS) {
  const minOf = [];
  for (const vp of VP) {
    test(`거친 단계 사용 + SSIM ≥ ${SSIM_MIN}: 시드 ${seed} ${vp.name}`, (t) => {
      const { cloud, h } = scene(seed);
      const cam = camOf(vp);
      const sel = selectLevels(h, cam, { thresholdPx: THRESHOLD_PX });
      const lod = materialize(h, sel);
      assert.equal(lod.count, sel.pointCount);
      const { coarsePts, maxLevel } = coarseStats(h, sel);
      const a = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M });
      const b = renderPoints(cam, lod, { pointSizeM: POINT_SIZE_M });
      const s = ssim(a.color, b.color, W, H, 3);
      const ratio = lod.count / cloud.count;
      if (seed === 1) ratios.push(ratio);
      minOf.push(s);
      const line = `시드 ${seed} ${vp.name}: SSIM ${s.toFixed(4)}, 점 비율 ${ratio.toFixed(3)}, 최대 단계 ${maxLevel}, 단계≥1 점 ${coarsePts}`;
      t.diagnostic(line);
      table.push(line);
      assert.ok(coarsePts > 0, `단계 ≥ 1 점이 없음: ${line}`);
      assert.ok(s >= SSIM_MIN, line);
    });
  }
  test(`시드 ${seed}: 시점 8곳 최소 SSIM ≥ ${SSIM_MIN}`, (t) => {
    assert.equal(minOf.length, VP.length, '시점별 시험이 모두 돌지 않음');
    const m = Math.min(...minOf);
    t.diagnostic(`시드 ${seed} 최소 SSIM ${m.toFixed(4)} (기록 ${MEASURED_MIN_SSIM[seed]})`);
    assert.ok(m >= SSIM_MIN, `시드 ${seed} 최소 SSIM ${m}`);
  });
}

// 음성 시험: 단계 선택을 0 으로 고정한 가짜 변이는 '거친 단계 사용' 구조 단언(단계≥1 점 > 0, 점 비율 상한)에서 실패해야 한다.
// 단계 0 선택은 렌더가 원본과 같아 SSIM 으로는 못 잡으므로 구조로 잡는다.
test('음성: 단계 0 고정 변이는 거친 단계 사용·점 비율 단언에서 실패한다', () => {
  const { cloud, h } = scene(1);
  for (const vp of VP) {
    const sel = selectLevels(h, camOf(vp), { thresholdPx: THRESHOLD_PX });
    assert.ok(coarseStats(h, sel).coarsePts > 0, `정상 선택은 통과해야 함: ${vp.name}`);
    const bad = forceLevel0(h, sel);
    assert.equal(coarseStats(h, bad).coarsePts, 0, `변이 ${vp.name}: 단계≥1 점이 남음`);  // forceLevel0 후 level≥1 점 검증
    assert.ok(bad.pointCount > sel.pointCount, `변이 ${vp.name}: 점 수가 줄지 않음`);
  }
  const meanBad = VP.reduce((acc, vp) => acc + forceLevel0(h, selectLevels(h, camOf(vp), { thresholdPx: THRESHOLD_PX })).pointCount / cloud.count, 0) / VP.length;
  assert.ok(meanBad > MEAN_RATIO_MAX, `변이의 평균 점 비율 ${meanBad.toFixed(3)} 가 상한 ${MEAN_RATIO_MAX} 이하`);
});

test(`시점 8곳 평균 점 비율 ≤ ${MEAN_RATIO_MAX}`, () => {
  assert.equal(ratios.length, VP.length, '시점별 시험이 모두 돌지 않음');
  const mean = ratios.reduce((x, y) => x + y, 0) / ratios.length;
  assert.ok(mean <= MEAN_RATIO_MAX, `평균 점 비율 ${mean.toFixed(3)}`);
});

test.after(() => {
  if (table.length) console.log(`# terrain 거친 단계 (${W}×${H}, 화각 ${FOV_Y_DEG}°, N=${N}, edge0M=${EDGE0_M.toFixed(3)}, τ=${THRESHOLD_PX}, pointSizeM=${POINT_SIZE_M})\n# ${table.join('\n# ')}`);
});
