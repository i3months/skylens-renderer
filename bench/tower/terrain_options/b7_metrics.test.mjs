// [cloud] b7_metrics 도구 자체 검증(측정 도구 시험, 계약 시험 아님) + F-491 ⑧ encodeQuantized cells < 2 거부.
// 작은 입력만 쓴다: 3×3 손계산 DEM, 2 m 셀 hill 한 장면, 1 m 셀 한 시드.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { towerViewpoints, makeHillDem } from '../../../client/tower/terrain/fixtures.mjs';
import { lowNoiseDem } from './b1_measure.mjs';
import { TERRAIN_SSIM_MIN } from '../../../contracts/controlview/terrain.mjs';
import { encodeQuantized } from './b4_formats.mjs';
import {
  normalAngleErrors, measureMetricScene, measureGroups, measureHalves, summarize, compareCited, formatB7, parseArgs,
  CITED_0057, CITED_HALVES, CITED_LOWNOISE_SSIM, B7_WINDOW, ssimShort,
} from './b7_metrics.mjs';

const WIN0 = { tileMin: 0, tileMax: 0 };
/** 한 타일(64 m)을 덮는 3×3 DEM(셀 32 m). */
const tiny = (hs) => ({ originX: 0, originY: 0, cellM: 32, width: 3, height: 3, heights: Float32Array.from(hs) });

test('법선 각: 간격 1 은 0, 기울어진 평면은 어떤 간격에서도 0', () => {
  const plane = tiny([0, 8, 16, 4, 12, 20, 8, 16, 24]); // z = 0.25 x + 0.125 y 꼴(선형)
  assert.ok(normalAngleErrors(plane, 1, WIN0).maxDeg < 1e-9);
  const p2 = normalAngleErrors(plane, 2, WIN0);
  assert.ok(p2.maxDeg < 1e-6, `평면 stride 2 최대 각 ${p2.maxDeg}`);
  assert.equal(p2.n, 9);
});

test('법선 각: 모서리 0·가운데 h 인 3×3 에서 모서리 정점 각이 손계산 atan(h√2/64) 이다', () => {
  const h = 32;
  const dem = tiny([0, 0, 0, 0, h, 0, 0, 0, 0]);
  const r = normalAngleErrors(dem, 2, WIN0);
  // 모서리 (0,0): 삼각형 두 개의 법선 (0,-32h,1024)·(-32h,0,1024) 합 → 수직에서 atan(32h√2/2048). 거친 메시는 평평하다(법선 수직).
  const corner = (Math.atan((h * Math.SQRT2) / 64) * 180) / Math.PI; // 35.264°
  assert.ok(Math.abs(corner - 35.2644) < 1e-3);
  assert.ok(r.maxDeg >= corner - 1e-9 && r.maxDeg < 90, `최대 ${r.maxDeg}`);
  assert.ok(r.rmsDeg >= r.meanDeg && r.meanDeg > 0);
  // 가운데 정점은 대칭이라 법선이 수직이고, 평평한 거친 메시와의 각이 0 이다 → 평균은 최대보다 작다.
  assert.ok(r.meanDeg < r.maxDeg);
});

test('법선 각: 높이가 클수록 각이 단조 증가하고 잘못된 입력은 던진다', () => {
  const a = normalAngleErrors(tiny([0, 0, 0, 0, 8, 0, 0, 0, 0]), 2, WIN0);
  const b = normalAngleErrors(tiny([0, 0, 0, 0, 32, 0, 0, 0, 0]), 2, WIN0);
  assert.ok(b.meanDeg > a.meanDeg && b.maxDeg > a.maxDeg);
  assert.throws(() => normalAngleErrors(tiny(new Array(9).fill(0)), 0, WIN0), RangeError);
  assert.throws(() => normalAngleErrors(tiny(new Array(9).fill(0)), 4, WIN0), RangeError); // 칸 수 2 가 4 의 배수 아님
  assert.throws(() => normalAngleErrors(tiny(new Array(9).fill(0)), 2), RangeError); // 기본 창 −2..1 이 DEM 밖
});

test('조건·요약: hill 한 장면은 e/cellM = 최대 오차 / 셀 크기, 같은 간격은 dup, SSIM 은 (0,1]', () => {
  const cams = towerViewpoints();
  const sc = measureMetricScene({ name: 'hill:1/0.015', make: () => makeHillDem({ seed: 1, noiseRatio: 0.015 }) }, cams, [0, 0.5, 1, 1], B7_WINDOW);
  assert.ok(sc.conditions.length >= 1);
  const seen = new Set();
  for (const c of sc.conditions) {
    assert.equal(c.cellM, 2);
    assert.ok(Math.abs(c.eOverCell - c.maxErrorM / 2) < 1e-12);
    assert.ok(c.stride > 1 && c.ssimMin8 > 0 && c.ssimMin8 <= 1);
    assert.ok(c.meanDeg <= c.rmsDeg + 1e-12 && c.rmsDeg <= c.maxDeg + 1e-12);
    assert.equal(c.dup, seen.has(c.stride));
    seen.add(c.stride);
  }
  const sm = summarize(sc.conditions);
  assert.equal(sm.n, seen.size); // dup 은 센 적 없다
  assert.ok(sm.eOverCell.min <= sm.eOverCell.max);
  assert.deepEqual(summarize([]), { n: 0 });
});

test('집단·반폭 측정과 표: 한 시드로 끝까지 돌고 0057 비교 표가 만들어진다', () => {
  const res = measureGroups({
    hill: [{ name: 'hill:1/0', make: () => makeHillDem({ seed: 1, noiseRatio: 0 }) }],
    low: [{ name: 'lowNoise:1', make: () => lowNoiseDem(1, 1) }],
  });
  assert.equal(res.groups.hill.scenes, 1);
  assert.equal(res.groups.lowNoise.scenes, 1);
  // 1 m 셀 ±0.15 잡음은 현행표에서 e/cellM 이 0.29~0.30 이다(0057: 간격 2 최대 오차 0.2960~0.2980 m).
  assert.ok(res.groups.lowNoise.eOverCell.max > 0.29 && res.groups.lowNoise.eOverCell.max < 0.31);
  res.halves = measureHalves({ halves: [0.12], seeds: [1] });
  const h = res.halves[0];
  assert.deepEqual(h.strides, ['1', '2', '4', '8']);
  assert.equal(h.fail, 0);
  assert.equal(h.conditions, 3);
  assert.ok(h.worstEM < 0.25 && h.worstEM > 0.23, `최악 e ${h.worstEM}`);
  const rows = compareCited(res);
  assert.equal(rows.length, CITED_0057.length + 1 + 1); // 반폭 0.12 한 행, lowNoise 최소 SSIM 한 행
  for (const r of rows) assert.ok('match' in r && 'diff' in r);
  const text = formatB7(res);
  assert.match(text, /0057 인용 수치와 재현 여부/);
  assert.match(text, /±0\.12 m \| \[0, 0\.25, 0\.25, 0\.25\] \| 1,2,4,8/);
});

test('인자 검사: --json 값 없음·모르는 토큰은 던진다', () => {
  assert.deepEqual(parseArgs([]), { json: null });
  assert.deepEqual(parseArgs(['--json', 'a.json']), { json: 'a.json' });
  assert.throws(() => parseArgs(['--json']), /값이 없다/);
  assert.throws(() => parseArgs(['--json', '--x']), /값이 없다/);
  assert.throws(() => parseArgs(['--only=x']), /알 수 없는 인자/);
});

test('F-491 ⑧: encodeQuantized 는 cells < 2·정수 아님을 RangeError 로 거부한다', () => {
  for (const cells of [0, 1, -3, 1.5, NaN]) {
    const tile = { tx: 0, ty: 0, cells, heights: Float32Array.from([0]) };
    assert.throws(() => encodeQuantized(tile, 0.01), (e) => e instanceof RangeError && /cells/.test(e.message), `cells ${cells}`);
  }
  // heights 길이가 cells² 와 맞는 cells = 1 도 거부(길이 검사가 통과해도 cells 검사가 막는다).
  assert.throws(() => encodeQuantized({ tx: 0, ty: 0, cells: 1, heights: Float32Array.from([5]) }, 0.01), RangeError);
  // cells = 2 는 통과한다.
  const ok = encodeQuantized({ tx: 0, ty: 0, cells: 2, heights: Float32Array.from([0, 0.01, 0.02, 0.03]) }, 0.01, { verify: true });
  assert.equal(ok.heights.length, 4);
});

// ---- F-497: 0057 대조 판정과 집단 분류 ----

const mm = (min, max) => ({ min, max });
/** 0057 인용값과 소수 자릿수 반올림 후 모두 일치하도록 손으로 만든 집단. 서로 다른 집단·최소/최대는 일부러 다른 값을 둔다(읽는 칸이 바뀌면 드러남). */
function citedGroups() {
  return {
    hill: { eOverCell: mm(0.1, 0.4041), meanDeg: mm(1, 3.9204), rmsDeg: mm(1, 4.3104), maxDeg: mm(1, 15.0704), ssimMin8: mm(0.99, 1) },
    lowNoise: { eOverCell: mm(0.2961, 0.2991), meanDeg: mm(1, 9), rmsDeg: mm(1, 9), maxDeg: mm(1, 99), ssimMin8: mm(0.9467, 0.99) },
    lowNoiseFail: { eOverCell: mm(0.2961, 0.2991), meanDeg: mm(3.5704, 9), rmsDeg: mm(4.0304, 9), maxDeg: mm(11.4204, 99), ssimMin8: mm(0.9467, 0.949) },
    lowNoisePass: { eOverCell: mm(0.29, 0.29), meanDeg: mm(2, 8), rmsDeg: mm(2, 8), maxDeg: mm(2, 88), ssimMin8: mm(0.95, 0.99) },
  };
}
const citedHalves = () => [
  { halfM: 0.1, minSsim: 0.97374 }, { halfM: 0.11, minSsim: 0.96896 }, { halfM: 0.12, minSsim: 0.96434 },
];

test('0057 인용 상수: 키·값·자릿수를 0057 리터럴로 고정한다(lowNoise 는 최소 0.296)', () => {
  assert.deepEqual(CITED_0057.map((c) => [c.key, c.cited, c.dec]), [
    ['hill e/cellM 최대', 0.404, 3],
    ['lowNoise e/cellM 최소', 0.296, 3],
    ['평균 각 실패 집단 최소', 3.57, 2],
    ['평균 각 통과 집단 최대', 3.92, 2],
    ['RMS 각 실패 집단 최소', 4.03, 2],
    ['RMS 각 통과 집단 최대', 4.31, 2],
    ['최대 각 실패 집단 최소', 11.42, 2],
    ['최대 각 통과 집단 최대', 15.07, 2],
  ]);
  assert.deepEqual({ ...CITED_HALVES }, { 0.1: 0.9737, 0.11: 0.969, 0.12: 0.9643 });
  assert.equal(CITED_LOWNOISE_SSIM, 0.9467);
});

test('compareCited: 일치하는 입력은 모든 행 match, 한 칸만 다르면 그 행만 불일치', () => {
  const groups = citedGroups();
  const rows = compareCited({ groups, halves: citedHalves() });
  assert.equal(rows.length, CITED_0057.length + 3 + 1);
  for (const r of rows) assert.equal(r.match, true, `${r.key} actual ${r.actual}`);
  assert.ok(Math.abs(rows[0].diff - (0.4041 - 0.404)) < 1e-12);
  // 불일치: hill e/cellM 최대 0.4041 → 0.4051(반올림 0.405), 반폭 0.11 0.96896 → 0.9680.
  groups.hill.eOverCell = mm(0.1, 0.4051);
  const halves = citedHalves(); halves[1].minSsim = 0.968;
  const bad = compareCited({ groups, halves });
  assert.deepEqual(bad.filter((r) => !r.match).map((r) => r.key), ['hill e/cellM 최대', '±0.11 m 최소 SSIM']);
  // 집단이 비면(값 없음) 불일치이며 던지지 않는다.
  const empty = { ...citedGroups(), lowNoiseFail: { n: 0 } };
  const rows2 = compareCited({ groups: empty, halves: [] });
  assert.equal(rows2.find((r) => r.key === '평균 각 실패 집단 최소').match, false);
});

test('compareCited: 각 행이 0057 이 말한 집단·최소/최대 칸을 읽는다', () => {
  const keyOf = (mutate) => {
    const g = citedGroups(); mutate(g);
    return compareCited({ groups: g, halves: citedHalves() }).filter((r) => !r.match).map((r) => r.key);
  };
  assert.deepEqual(keyOf((g) => { g.lowNoise.eOverCell.max = 0.296; g.lowNoise.eOverCell.min = 0.1; }), ['lowNoise e/cellM 최소']);
  assert.deepEqual(keyOf((g) => { g.lowNoise.meanDeg.max = 3.92; g.hill.meanDeg.max = 7; }), ['평균 각 통과 집단 최대']);
  assert.deepEqual(keyOf((g) => { g.lowNoisePass.maxDeg.max = 15.07; g.hill.maxDeg.max = 14; }), ['최대 각 통과 집단 최대']);
  assert.deepEqual(keyOf((g) => { g.lowNoiseFail.rmsDeg.min = 5; }), ['RMS 각 실패 집단 최소']);
});

test('집단 분류: hill 은 hill 조건만, lowNoise 는 ssimMin8 기준으로 미달·통과로 나뉘고 합 = 전체', () => {
  const cams = towerViewpoints();
  const hillE = { name: 'hill:1/0.015', make: () => makeHillDem({ seed: 1, noiseRatio: 0.015 }) };
  const lowE = { name: 'lowNoise:1', make: () => lowNoiseDem(1, 1) };
  const table = [0, 0.5, 1, 1];
  const res = measureGroups({ hill: [hillE], low: [lowE], table });
  const hc = measureMetricScene(hillE, cams, table).conditions;
  const lc = measureMetricScene(lowE, cams, table).conditions;
  assert.deepEqual(res.groups.hill, { scenes: 1, ...summarize(hc), failing: hc.filter((c) => !c.dup && c.ssimMin8 < TERRAIN_SSIM_MIN).length });
  const fail = lc.filter((c) => c.ssimMin8 < TERRAIN_SSIM_MIN), pass = lc.filter((c) => c.ssimMin8 >= TERRAIN_SSIM_MIN);
  assert.equal(fail.length + pass.length, lc.length);
  assert.deepEqual(res.groups.lowNoise, { scenes: 1, ...summarize(lc), failing: fail.filter((c) => !c.dup).length });
  assert.deepEqual(res.groups.lowNoiseFail, { scenes: 1, ...summarize(fail) });
  assert.deepEqual(res.groups.lowNoisePass, { scenes: 1, ...summarize(pass) });
  assert.equal(res.groups.lowNoiseFail.n + res.groups.lowNoisePass.n, res.groups.lowNoise.n);
  // 두 집단의 지표가 실제로 다르다(hill 요약에 lowNoise 가 섞이면 드러난다).
  assert.notEqual(res.groups.hill.eOverCell.max, res.groups.lowNoise.eOverCell.max);
  // 미달 집단의 SSIM 은 모두 기준 미만, 통과 집단은 모두 이상.
  if (res.groups.lowNoiseFail.n) assert.ok(res.groups.lowNoiseFail.ssimMin8.max < TERRAIN_SSIM_MIN);
  if (res.groups.lowNoisePass.n) assert.ok(res.groups.lowNoisePass.ssimMin8.min >= TERRAIN_SSIM_MIN);
});

test('F-496 ⑤: SSIM 미달 판정은 NaN 을 미달로 센다', () => {
  assert.equal(ssimShort(NaN), true);
  assert.equal(ssimShort(TERRAIN_SSIM_MIN), false);
  assert.equal(ssimShort(TERRAIN_SSIM_MIN - 1e-9), true);
  assert.equal(ssimShort(1), false);
});
