// [cloud CPU 렌더] 관제탑 지형 H32 양자화 8시점 SSIM 시험(T15.10e, F-458 확인 기준, F-493 재측정). 계약 contracts/tower_assets/terrain_h32.mjs 의
// quantizeHeights(heights, STEP_M) → dequantizeHeights 로 높이를 왕복시킨 LOD 1~3 타일을 층(createTerrainLayer)으로 그려,
// 같은 DEM 의 LOD 0(f32, 양자화 없음 — 계약상 LOD 0 은 늘 비양자화) 기준 영상과 8시점 SSIM 을 잰다.
// 절차·장면 생성·측정 함수는 ssim_h32_sweep.mjs(step 후보 훑기 스크립트)와 공용이다(같은 파일에서 가져옴).
// STEP_M: 계약 TERRAIN_H32_STEP_M(0.05 m)은 F-493 에서 hill 시드 23 잡음 0 LOD 2·3 street_level 에서 SSIM 0.9486 으로 0.95 를 어겼다.
//   ssim_h32_sweep.mjs 로 step 후보를 측정 전에 고정한 108 장면에서 잰 뒤 고른 값을 지금은 이 시험 파일 상수로 둔다.
//   계약 상수 TERRAIN_H32_STEP_M 을 이 값으로 바꿔야 한다(계약 파일은 다른 작업 소유라 여기서 고치지 않음).
// 장면(측정 전에 고정): hill 시드 1..12 와 23 × 잡음 {0, 0.015}(2 m 셀), noiseBig 시드 0..3, lowNoise 시드 1..3,
//   lowNoise012 시드 1..3(1 m 셀 ±0.12 m 잡음, LOD 솎기 + 양자화 동시). 나머지(hill 1..40, noiseBig 0..7, lowNoise 1..8,
//   lowNoise012 1..12)는 시간 때문에 ssim_h32_sweep.mjs 로 잰다.
// 측정(2026-10-06, ssim_h32_sweep.mjs 108 장면, 최소 SSIM): step 0.05 → 0.9482(lowNoise012:12)·hill:23/0 0.9486 미달,
//   0.04 → 0.9496 미달(lowNoise012:9), 0.03 → 0.9543(lowNoise012:1 LOD 2 tower_mid; hill 0.9629), 0.025 → 0.9554, 0.02 → 0.9567,
//   0.0125 → 0.9587. 0.95 를 모든 장면에서 만족하는 가장 큰 후보는 0.03. 여유 0.01 은 어떤 후보도 못 채운다 — lowNoise012 는
//   양자화 없이도 LOD 솎기만으로 최소 0.9647 이라 여유를 정하는 것은 step 이 아니라 LOD 간격이다.
// 변이 확인(2026-10-06, 사본에서 STEP_M 을 0.05 로 바꿔 실행): (1) 실패(최소 0.9486, hill:23/0 LOD 2 street_level), 나머지 통과.
// 판정:
//   (1) 모든 장면·LOD 1~3·8시점 양자화 SSIM >= TERRAIN_SSIM_MIN(0.95, 계약). 낮추지 않는다.
//   (2) 양자화 안 한 영상 대비 SSIM 하락량 — 정보 출력만(판정 아님). 이전 주석의 '하락은 step 에 거의 비례' 는 실측과 어긋났다
//       (step 0.055 최소 0.9563 > step 0.05 의 0.9555, F-496 ③). 하락은 step 에 단조롭지 않아 측정 후 상한으로 거르는 근거가 없다.
//   (3) 시험 시간: 장면 계산의 이 프로세스 CPU 시간(process.cpuUsage, 사용자+시스템) 상한. 벽시계가 아니라 CPU 시간이라
//       병렬 시험 부하로 대기 시간이 늘어도 커지지 않는다(F-496 ④).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { TERRAIN_SSIM_MIN } from '../../../contracts/controlview/terrain.mjs';
import { LODS, loadMods, sceneList, measureScene } from './ssim_h32_sweep.mjs';

// ---- 미리 정한 값 ----
const STEP_M = 0.03; // 시험 파일 상수(계약 TERRAIN_H32_STEP_M 을 이 값으로 바꿔야 함). 되돌림 변이 때 0.05 로 바꾼다.
const VIEWS = 8;
const SCENES = Object.freeze({
  hillSeeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23],
  hillNoises: [0, 0.015],
  noiseBigSeeds: [0, 1, 2, 3],
  lowNoiseSeeds: [1, 2, 3],
  lowNoise012Seeds: [1, 2, 3],
});
// 장면 계산 CPU 시간 상한. 측정(2026-10-06, 4코어 cloud, 36 장면): CPU 약 37.5 s(벽시계 약 37 s). 상한 120 s 는 측정의 약 3.2 배로,
//   CPU 시간이라 병렬 부하에는 커지지 않고, 더 느린 CPU(약 3 배)까지 흡수한다. 장면이 늘거나 렌더가 크게 느려지면 실패한다.
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
      const m = measureScene(loaded.mods, cams, sc.make(), [STEP_M]);
      return { group: sc.group, label: sc.label, f32: m.f32, quant: m.quant[0], strides: m.strides, nullTiles: m.nullTiles[0], maxQErr: m.maxQErr[0] };
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
    const bad = [];
    let min = Infinity, where = '';
    for (const sc of scenes) {
      sc.quant.forEach((v, li) => v.forEach((x, k) => {
        if (!(x >= min)) { min = x; where = `${sc.label} LOD ${LODS[li]} 시점 ${k}(${cams[k].name})`; }
        if (!(x >= TERRAIN_SSIM_MIN)) bad.push(`${sc.label} LOD ${LODS[li]} 시점 ${k}: ${x.toFixed(4)}`);
      }));
    }
    console.log(`[ssim_h32] 양자화 최소 SSIM ${min.toFixed(4)} (${where})`);
    assert.deepEqual(bad, [], `양자화 타일이 ${TERRAIN_SSIM_MIN} 미달`);
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
