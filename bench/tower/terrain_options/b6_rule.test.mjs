// T15.10d(F-474, 결정 0057): 셀 크기 비례 기울기 항 상한 규칙의 SSIM 회귀 시험.
// lowNoise(1 m 셀, ±0.15 m 화소 잡음) 시드 1..12 × LOD 1..3 = 36 조건 모두 8시점 최소 SSIM ≥ 0.95(ssim_views 절차: 160×90·8시점·
// 가운데 4×4 타일, b1_measure measureDem). 현행 절대표 [0, 0.5, 1, 1] 에서는 이 36 조건 중 20 이 0.95 미만이었다(결정 0056 B1).
// 기준 수치는 미리 정한 값(계약 0.95)을 리터럴로도 박는다 — 계약 상수가 바뀌어도 이 시험은 0.95 를 요구한다.
// 시드는 1..12 전부(측정 뒤 고르지 않음). 대조로 lowNoise2m(2 m 셀) 12 장면 × 3 = 36 조건, noiseBig 12 장면도 같은 기준으로 단언한다.
// 실행: node --test bench/tower/terrain_options/b6_rule.test.mjs (약 40 s 안팎, 벽시계 한도 넉넉히)
import test from 'node:test';
import assert from 'node:assert/strict';
import { TERRAIN_SSIM_MIN } from '../../../contracts/controlview/terrain.mjs';
import { towerViewpoints } from '../../../client/tower/terrain/fixtures.mjs';
import { b6DemSet, measureRuleDem, ruleBounds, B6_SEEDS } from './b6_rule.mjs';

const SSIM_MIN = 0.95; // SPEC S9 / contracts TERRAIN_SSIM_MIN. 낮추지 않는다.
const TIMEOUT_MS = 600_000;

test('계약 기준과 시험 리터럴이 같다', () => {
  assert.equal(TERRAIN_SSIM_MIN, SSIM_MIN);
  assert.deepEqual([...B6_SEEDS], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual([...ruleBounds(1)], [0, 0.25, 0.25, 0.25]);
  assert.deepEqual([...ruleBounds(2)], [0, 0.5, 0.5, 0.5]);
});

function runGroup(group) {
  const cams = towerViewpoints();
  const rows = [];
  for (const d of b6DemSet([group])) {
    const r = measureRuleDem(d, cams, { withBaseline: false });
    rows.push({ name: d.name, levels: r.options.rule.levels });
  }
  return rows;
}

function assertAll(rows, label) {
  const bad = [];
  let min = Infinity, n = 0;
  for (const r of rows) {
    assert.ok(r.levels[0].ssimMin8 >= 0.99, `${r.name} LOD0 ${r.levels[0].ssimMin8}`);
    for (const l of r.levels.slice(1)) {
      n++;
      min = Math.min(min, l.ssimMin8);
      if (!(l.ssimMin8 >= SSIM_MIN)) bad.push(`${r.name} LOD${l.lod}@${l.stride}=${l.ssimMin8.toFixed(4)}`);
    }
  }
  console.log(`[b6] ${label}: ${n} 조건 LOD1~3 최소 SSIM ${min.toFixed(4)}, 간격 ${[...new Set(rows.map((r) => r.levels.map((l) => l.stride).join(',')))].join(' / ')}`);
  assert.deepEqual(bad, [], `${label} 에서 ${SSIM_MIN} 미달`);
  return n;
}

test('lowNoise(1 m 셀) 시드 1..12 × LOD1..3 = 36 조건 8시점 최소 SSIM >= 0.95', { timeout: TIMEOUT_MS }, () => {
  const rows = runGroup('lowNoise');
  assert.equal(rows.length, 12);
  assert.equal(assertAll(rows, 'lowNoise'), 36);
});

test('대조 lowNoise2m(2 m 셀) 36 조건 >= 0.95, 간격은 명목 그대로(1,2,4,8 — 규칙이 2 m 셀에서 LOD 를 막지 않는다)', { timeout: TIMEOUT_MS }, () => {
  const rows = runGroup('lowNoise2m');
  assert.equal(assertAll(rows, 'lowNoise2m'), 36);
  for (const r of rows) assert.deepEqual(r.levels.map((l) => l.stride), [1, 2, 4, 8], r.name);
});

test('noiseBig 12 장면 × LOD1..3 >= 0.95', { timeout: TIMEOUT_MS }, () => {
  const rows = runGroup('noiseBig');
  assert.equal(assertAll(rows, 'noiseBig'), 36);
});
