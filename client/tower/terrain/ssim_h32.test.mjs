// [cloud CPU 렌더] 관제탑 지형 H32 양자화 8시점 SSIM 시험(T15.10e, F-458 확인 기준, F-493 재측정). 계약 contracts/tower_assets/terrain_h32.mjs 의
// quantizeHeights(heights, TERRAIN_H32_STEP_M) → dequantizeHeights(kbase, step, q)(전역 격자) 로 높이를 왕복시킨 LOD 1~3 타일을
// 층(createTerrainLayer)으로 그려, 같은 DEM 의 LOD 0(f32, 양자화 없음 — 계약상 LOD 0 은 늘 비양자화) 기준 영상과 8시점 SSIM 을 잰다.
// step 은 이 파일 상수가 아니라 계약 TERRAIN_H32_STEP_M 을 가져와 쓴다(계약이 정한 step 이 실제로 검증된다).
// 절차·장면 생성·측정 함수는 ssim_h32_sweep.mjs(step 후보 훑기 스크립트)와 공용이다(같은 파일에서 가져옴).
// 측정(2026-10-06, 전역 격자 kbase 코드 6e138ea, ssim_h32_sweep.mjs 128 장면 = hill 시드 1..50 × 잡음 {0, 0.015}, noiseBig 0..7,
//   lowNoise 1..8, lowNoise012 1..12, LOD 1~3 × 8시점, 장면은 측정 전에 고정). 전 장면 최소 SSIM(여유 = 최소 − 0.95):
//   step 0.25 → 0.9489 미달(noiseBig:6 LOD 1 low_close_box; 미달 장면은 이것 하나), 0.15 → 0.9627(여유 0.0127, lowNoise012:12),
//   0.1 → 0.9642, 0.075 → 0.9647, 0.05 → 0.9647, 0.03 → 0.9648. hill 만 보면 모든 step 에서 0.9806 이상, hill:23/0 은 0.9900~0.9911.
//   전 장면 최소를 정하는 lowNoise012 는 양자화 없이도 LOD 솎기만으로 0.9647 이다. 1b07de8(타일별 base)에서 잰 옛 훑기
//   (0.05 미달·0.03 이 최대 통과)는 전역 격자 뒤 성립하지 않는다.
//   규칙(모든 장면 >= 0.95 이고 여유 >= 0.01 인 가장 큰 후보)에 따른 권고 step 은 0.15 m. 계약 상수 바꾸기는 계약 소유 작업이 한다.
// 장면(시험, 위 128 장면의 부분집합): hill 시드 1..4, 10, 23, 41..45 × 잡음 {0, 0.015}(hill 23 과 감독 확인용 41..45, hill 최소
//   장면 10), noiseBig 2·6(0.25 에서 유일한 미달 장면 6), lowNoise 6, lowNoise012 1·6·12(전 장면 최소 위치). 나머지는 단독 실행
//   시간 때문에 ssim_h32_sweep.mjs 로 잰다.
// 변이 확인: 같은 장면을 step MUTATION_STEP_M(0.25)으로도 양자화해 판정 (1) 을 그대로 적용하면 실패해야 한다(시험 안에서 확인).
//   실제 실행(2026-10-06): 사본에서 STEP_M 을 0.25 로 바꿔 돌리면 (1) 실패(최소 0.9489 noiseBig:6 LOD 1 low_close_box, 미달 3 시점이
//   모두 noiseBig:6), 0.15 로 바꾸면 6 개 모두 통과(최소 0.9627 lowNoise012:12, 여유 0.0127). 계약값 0.03 은 최소 0.9648.
// 판정:
//   (1) 모든 장면·LOD 1~3·8시점 양자화 SSIM >= TERRAIN_SSIM_MIN(0.95, 계약). 낮추지 않는다.
//   (2) 양자화 안 한 영상 대비 SSIM 하락량 — 정보 출력만(판정 아님). 하락은 step 에 단조롭지 않아(F-496 ③) 측정 후 상한으로
//       거르는 근거가 없다.
//   (3) 시험 시간: 장면 계산의 이 프로세스 CPU 시간(process.cpuUsage, 사용자+시스템) 상한. 벽시계가 아니라 CPU 시간이라
//       병렬 시험 부하로 대기 시간이 늘어도 커지지 않는다(F-496 ④).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { TERRAIN_SSIM_MIN } from '../../../contracts/controlview/terrain.mjs';
import { TERRAIN_H32_STEP_M } from '../../../contracts/tower_assets/terrain_h32.mjs';
import { LODS, loadMods, sceneList, measureScene } from './ssim_h32_sweep.mjs';

// ---- 미리 정한 값 ----
const STEP_M = TERRAIN_H32_STEP_M; // 계약 step(파일 상수 아님)
const MUTATION_STEP_M = 0.25; // 변이: 이 step 이면 판정 (1) 이 실패해야 한다(훑기 실측 0.9489, noiseBig:6)
const VIEWS = 8;
const SCENES = Object.freeze({
  hillSeeds: [1, 2, 3, 4, 10, 23, 41, 42, 43, 44, 45],
  hillNoises: [0, 0.015],
  noiseBigSeeds: [2, 6],
  lowNoiseSeeds: [6],
  lowNoise012Seeds: [1, 6, 12],
});
/** 판정 (1): 양자화 SSIM 이 TERRAIN_SSIM_MIN 미달인 항목 목록과 최소값·위치. key 는 장면의 양자화 결과 필드 이름. */
function judgeMin(scenes, cams, key) {
  const bad = [];
  let min = Infinity, where = '';
  for (const sc of scenes) {
    sc[key].forEach((v, li) => v.forEach((x, k) => {
      if (!(x >= min)) { min = x; where = `${sc.label} LOD ${LODS[li]} 시점 ${k}(${cams[k].name})`; }
      if (!(x >= TERRAIN_SSIM_MIN)) bad.push(`${sc.label} LOD ${LODS[li]} 시점 ${k}: ${x.toFixed(4)}`);
    }));
  }
  return { bad, min, where };
}
// 장면 계산 CPU 시간 상한. 측정(2026-10-06, 4코어 cloud, 28 장면 × step 2개): CPU 약 32~37 s(단독 실행 벽시계 약 35 s). 상한 120 s 는
//   측정의 약 3.2 배로, CPU 시간이라 병렬 부하에는 커지지 않고 더 느린 CPU(약 3 배)까지 흡수한다. 장면이 늘거나 렌더가 크게 느려지면 실패한다.
const CPU_MS_MAX = 120000;

describe(`지형 H32 양자화(step ${STEP_M} m) 8시점 SSIM: LOD 1~3 양자화 타일 대 LOD 0 기준`, () => {
  let cams, scenes, cpuMs, wallMs;

  before(async () => {
    const loaded = await loadMods();
    cams = loaded.cams;
    assert.equal(cams.length, VIEWS);
    const list = sceneList(loaded.mods, SCENES);
    const c0 = process.cpuUsage(), t0 = Date.now();
    scenes = list.map((sc) => {
      const m = measureScene(loaded.mods, cams, sc.make(), [STEP_M, MUTATION_STEP_M]);
      return { group: sc.group, label: sc.label, f32: m.f32, quant: m.quant[0], mutQuant: m.quant[1], strides: m.strides, nullTiles: m.nullTiles[0], maxQErr: m.maxQErr[0] };
    });
    const c = process.cpuUsage(c0);
    cpuMs = (c.user + c.system) / 1000; wallMs = Date.now() - t0;
    const rows = scenes.map((sc) => `  ${sc.label.padEnd(16)} 간격 ${sc.strides.join(',')} LOD1..3 양자화 최소 ${sc.quant.map((v) => Math.min(...v).toFixed(4)).join(' ')}`
      + ` | 하락 최대 ${sc.quant.map((v, l) => Math.max(...v.map((x, k) => sc.f32[l][k] - x)).toFixed(4)).join(' ')}`);
    console.log(`[ssim_h32] step ${STEP_M} m, ${scenes.length} 장면 × LOD 1~3 × 8시점 (CPU ${cpuMs.toFixed(0)} ms, 벽시계 ${wallMs} ms)\n${rows.join('\n')}`);
  });

  test('전제: 필수 장면(hill 시드 23, lowNoise012)이 들어 있고 lowNoise012 는 LOD 솎기가 일어난다', () => {
    assert.ok(scenes.some((sc) => sc.label === 'hill:23/0'));
    const l012 = scenes.filter((sc) => sc.group === 'lowNoise012');
    assert.ok(l012.length >= 1);
    for (const sc of l012) assert.ok(sc.strides.some((s) => s > 1), `${sc.label}: 간격 ${sc.strides.join(',')} (솎기 없음)`);
  });

  test('전제: 모든 LOD 1~3 타일이 양자화되고 복원 오차가 step/2 (+ f32 반올림) 이하다', () => {
    for (const sc of scenes) {
      assert.equal(sc.nullTiles, 0, `${sc.label}: 양자화 불가 타일 ${sc.nullTiles}(시험이 f32 를 재게 됨)`);
      assert.ok(sc.maxQErr > 0, `${sc.label}: 복원 오차 0(양자화가 실제로 일어나지 않음)`);
      assert.ok(sc.maxQErr <= STEP_M / 2 + 1e-5, `${sc.label}: 복원 오차 ${sc.maxQErr} > step/2`);
    }
  });

  test(`(1) 양자화 LOD 1~3 대 LOD 0 기준: 모든 장면·8시점 최소 SSIM >= ${TERRAIN_SSIM_MIN}`, () => {
    const { bad, min, where } = judgeMin(scenes, cams, 'quant');
    console.log(`[ssim_h32] 양자화 최소 SSIM ${min.toFixed(4)} (${where}), 여유 ${(min - TERRAIN_SSIM_MIN).toFixed(4)}`);
    assert.deepEqual(bad, [], `양자화 타일이 ${TERRAIN_SSIM_MIN} 미달`);
  });

  test(`변이: step ${MUTATION_STEP_M} m 으로 양자화하면 판정 (1) 이 실패한다(판정이 step 에 민감함)`, () => {
    const { bad, min, where } = judgeMin(scenes, cams, 'mutQuant');
    console.log(`[ssim_h32] 변이 step ${MUTATION_STEP_M} m: 최소 SSIM ${min.toFixed(4)} (${where}), 미달 ${bad.length} 개`);
    assert.ok(bad.length > 0, `step ${MUTATION_STEP_M} m 에서도 (1) 통과(최소 ${min.toFixed(4)}) — 시험 장면이 step 을 가려내지 못함`);
  });

  test('(2) 정보: 양자화 안 한 같은 장면 대비 SSIM 하락량 장면군별 최댓값(판정 아님)', () => {
    const worst = {};
    for (const sc of scenes) {
      sc.quant.forEach((v, li) => v.forEach((x, k) => {
        const d = sc.f32[li][k] - x;
        if (!worst[sc.group] || d > worst[sc.group].d) worst[sc.group] = { d, at: `${sc.label} LOD ${LODS[li]} 시점 ${k}` };
      }));
    }
    console.log(`[ssim_h32] 하락 최대: ${Object.entries(worst).map(([g, w]) => `${g} ${w.d.toFixed(4)}(${w.at})`).join(' | ')}`);
    for (const w of Object.values(worst)) assert.ok(Number.isFinite(w.d));
  });

  test(`시험 시간: 장면 계산 CPU 시간 < ${CPU_MS_MAX} ms`, () => {
    assert.ok(cpuMs < CPU_MS_MAX, `CPU ${cpuMs.toFixed(0)} ms (벽시계 ${wallMs} ms)`);
  });
});
