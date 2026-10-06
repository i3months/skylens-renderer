// T15.10d(F-474, 결정 0057): 셀 크기 비례 기울기 항 상한 규칙의 SSIM 회귀 시험.
// lowNoise(1 m 셀, ±0.15 m 화소 잡음) 시드 1..12 × LOD 1..3 = 36 조건 모두 8시점 최소 SSIM ≥ 0.95(ssim_views 절차: 160×90·8시점·
// 가운데 4×4 타일, b1_measure measureDem). 현행 절대표 [0, 0.5, 1, 1] 에서는 이 36 조건 중 20 이 0.95 미만이었다(결정 0056 B1).
// 기준 수치는 미리 정한 값(계약 0.95)을 리터럴로도 박는다 — 계약 상수가 바뀌어도 이 시험은 0.95 를 요구한다.
// 시드는 1..12 전부(측정 뒤 고르지 않음). 대조로 lowNoise2m(2 m 셀) 12 장면 × 3 = 36 조건, noiseBig 12 장면도 같은 기준으로 단언한다.
// 주의(F-480): 1 m 셀 lowNoise·noiseBig 은 규칙 간격이 1,1,1,1 이라 LOD1~3 = LOD0 — SSIM 자명(항등). 그래서 간격 [1,1,1,1] 을 함께 단언하고
//   LOD3 바이트를 출력한다(이 두 시험은 '규칙이 1 m 셀 ±0.15 m 잡음을 솎아내지 않는다' 를 보이는 것이지 솎아낸 메시의 화질을 보이는 것이 아니다).
// 솎아내는 1 m 셀 조건(F-474 다시 엶): lowNoise012(±0.12 m 잡음, 시드 1..12) 는 간격 [1,2,4,8] 로 실제로 솎아내고 36 조건 SSIM ≥ 0.95 를 단언한다.
//   lowNoise(규칙이 너무 느슨하면 실패)와 lowNoise012(규칙이 너무 조이면 실패)가 1 m 셀 상한을 양쪽에서 묶는다.
// 서버 대조(F-481): 규칙 간격은 terrainLodStride 와, 타일 높이는 buildTerrainTile 과 DEM 마다 대조하고(measureRuleDem), 대조 타일 수를 단언한다.
// 실행: node --test bench/tower/terrain_options/b6_rule.test.mjs (단독 실행 시간: 감독 측정 55~59 s, 이 환경 2026-10-06 측정 36 s — 기계에 따라 다르니 벽시계 한도 넉넉히. 항등 그룹도 현행표 되돌림 변이를 잡으므로 지우지 않는다, F-487 ③)
import test from 'node:test';
import assert from 'node:assert/strict';
import { TERRAIN_SSIM_MIN } from '../../../contracts/controlview/terrain.mjs';
import { towerViewpoints } from '../../../client/tower/terrain/fixtures.mjs';
import { formatB6, b6DemSet, measureRuleDem, ruleBounds, B6_SEEDS, B6_GROUPS, noiseHalfDem, LOW_NOISE_012_HALF_M, checkTilesAgainstServer, parseGroups, parseB6Only } from './b6_rule.mjs';
import { lowNoiseDem } from './b1_measure.mjs';
import { buildTileWithStride } from './b1_lod.mjs';
import { terrainLodStride } from '../../../server/terrain/mesh_lod/index.mjs';

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
    // 서버 타일 높이 대조가 실제로 돌았다: LOD 4 × 타일 3.
    assert.equal(r.serverTilesChecked, 12, `${d.name} 서버 높이 대조 타일 수`);
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
  const lod3 = rows.map((r) => r.levels[3]);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  console.log(`[b6] ${label}: ${n} 조건 LOD1~3 최소 SSIM ${min.toFixed(4)}, 간격 ${[...new Set(rows.map((r) => r.levels.map((l) => l.stride).join(',')))].join(' / ')}, `
    + `LOD3 메시 합 ${sum(lod3.map((l) => l.meshRawBytes))} B · 높이만 합 ${sum(lod3.map((l) => l.heightOnlyRawBytes))} B (${rows.length} 장면)`);
  assert.deepEqual(bad, [], `${label} 에서 ${SSIM_MIN} 미달`);
  return n;
}

test('lowNoise(1 m 셀 ±0.15 m) 1 m 셀 간격 1 — SSIM 자명(항등): 시드 1..12 간격 [1,1,1,1] 단언, 36 조건 >= 0.95', { timeout: TIMEOUT_MS }, () => {
  const rows = runGroup('lowNoise');
  assert.equal(rows.length, 12);
  // 규칙을 옛 표(상한 0.5)로 되돌리면 간격 1,2,4,8 이 되어 아래 간격 단언에서 먼저 멈춘다(SSIM 단언까지 가지 않는다).
  // 현행표 되돌림이 SSIM 에서 실패한다는 것은 이 시험이 아니라 결정 0056 B1 측정(20/36 미달)의 사실이다.
  for (const r of rows) assert.deepEqual(r.levels.map((l) => l.stride), [1, 1, 1, 1], r.name);
  assert.equal(assertAll(rows, 'lowNoise(항등)'), 36);
});

test('lowNoise012(1 m 셀 ±0.12 m, 솎아냄) 시드 1..12 간격 [1,2,4,8] 단언, 36 조건 8시점 최소 SSIM >= 0.95', { timeout: TIMEOUT_MS }, () => {
  const rows = runGroup('lowNoise012');
  assert.equal(rows.length, 12);
  // 실제로 솎아내는 조건: 간격 > 1. 규칙이 1 m 셀에서 상한을 0.24 m 미만으로 조이면(예: 기울기 상수 0.2) 간격이 줄어 여기서 실패한다.
  for (const r of rows) assert.deepEqual(r.levels.map((l) => l.stride), [1, 2, 4, 8], r.name);
  for (const r of rows) for (const l of r.levels.slice(1)) assert.ok(l.maxErrorM >= 0.236 && l.maxErrorM <= 0.2399, `${r.name} LOD${l.lod} 최대 오차 ${l.maxErrorM}`);
  assert.equal(assertAll(rows, 'lowNoise012(솎아냄)'), 36);
});

test('대조 lowNoise2m(2 m 셀) 36 조건 >= 0.95, 간격은 명목 그대로(1,2,4,8 — 규칙이 2 m 셀에서 LOD 를 막지 않는다)', { timeout: TIMEOUT_MS }, () => {
  const rows = runGroup('lowNoise2m');
  assert.equal(assertAll(rows, 'lowNoise2m'), 36);
  for (const r of rows) assert.deepEqual(r.levels.map((l) => l.stride), [1, 2, 4, 8], r.name);
});

test('noiseBig 1 m 셀 간격 1 — SSIM 자명(항등): 12 장면 간격 [1,1,1,1] 단언, LOD1..3 >= 0.95', { timeout: TIMEOUT_MS }, () => {
  const rows = runGroup('noiseBig');
  // 규칙과 무관: 이 간격 [1,1,1,1] 은 옛 표(절대표 [0, 0.5, 1, 1])에서도 같다(노이즈가 커서 어느 표든 솎아내지 못한다). 규칙 변이를 잡는 시험이 아니다.
  for (const r of rows) assert.deepEqual(r.levels.map((l) => l.stride), [1, 1, 1, 1], r.name);
  assert.equal(assertAll(rows, 'noiseBig(항등)'), 36);
});

test('noiseHalfDem(·, 0.15) 은 lowNoiseDem 과 바이트가 같다(lowNoise012 는 잡음 반폭만 다른 같은 정의)', () => {
  assert.equal(LOW_NOISE_012_HALF_M, 0.12);
  for (const s of [1, 7, 12]) for (const c of [1, 2]) {
    const a = noiseHalfDem(s, 0.15, c), b = lowNoiseDem(s, c);
    for (const k of ['originX', 'originY', 'cellM', 'width', 'height']) assert.equal(a[k], b[k], `${k} seed ${s} cell ${c}`);
    assert.equal(a.heights.length, b.heights.length);
    assert.ok(a.heights.every((v, k) => v === b.heights[k]), `seed ${s} cell ${c}`);
  }
});

test('서버 타일 높이 대조: 사본 높이를 바꾸거나 간격이 다르면 던진다', () => {
  const dem = noiseHalfDem(3, LOW_NOISE_012_HALF_M, 1);
  const strides = [0, 1, 2, 3].map((l) => terrainLodStride(dem, l));
  assert.equal(checkTilesAgainstServer(dem, strides), 12);
  // 변이: 사본이 한 정점 높이를 1e-3 m 바꾼다.
  const bent = (d, tx, ty, lod, st) => { const t = buildTileWithStride(d, tx, ty, lod, st); if (lod === 2) t.heights[5] += 1e-3; return t; };
  assert.throws(() => checkTilesAgainstServer(dem, strides, bent), /높이 불일치 LOD 2/);
  // 변이: 사본 간격이 서버와 다르다. 서버 간격(계약 terrainLodMaxErrorM 으로 정해진 값)에서 LOD 1 만 반으로(1 이면 2배로) 바꿔 만든다.
  // 규칙 상수(기울기 0.25)에 묶인 리터럴을 쓰지 않는다. 바꾼 LOD 에서 던져야 한다.
  const badLod = 1;
  const badStrides = strides.map((s, l) => (l !== badLod ? s : s > 1 ? s / 2 : s * 2));
  assert.notEqual(badStrides[badLod], strides[badLod]);
  assert.throws(() => checkTilesAgainstServer(dem, badStrides), new RegExp(`LOD ${badLod}`));
});

test('--groups·--only 검사(F-484 ②): 오타·빈 값은 던지고, 정상 이름은 통과', () => {
  assert.equal(parseGroups(undefined), undefined);
  assert.deepEqual(parseGroups('lowNoise,lowNoise012'), ['lowNoise', 'lowNoise012']);
  assert.throws(() => parseGroups('lowNoize'), /알 수 없는 그룹: lowNoize/);
  assert.throws(() => parseGroups(''), /비어/);
  assert.throws(() => parseGroups('hill,'), /빈 이름/);
  assert.throws(() => b6DemSet(['nope']), /알 수 없는 그룹/);
  assert.deepEqual([...B6_GROUPS], ['lowNoise', 'lowNoise012', 'lowNoise2m', 'noiseBig', 'hill']);
  assert.deepEqual(parseB6Only('lowNoise:1,lowNoise012:12,hill:3/0.015'), ['lowNoise:1', 'lowNoise012:12', 'hill:3/0.015']);
  assert.equal(parseB6Only(null), null);
  assert.throws(() => parseB6Only('lowNoize:1'), /알 수 없는 이름: lowNoize:1/);
  assert.throws(() => parseB6Only(''), /비어/);
  // 그룹으로 좁힌 뒤 그 밖의 이름은 빈 표 대신 던진다.
  assert.throws(() => parseB6Only('lowNoise:1', ['hill']), /알 수 없는 이름/);
});

test('formatB6: NaN SSIM 은 0.95 미만 건수(실패)로 센다(F-487 ①)', () => {
  const lv = (stride, ssim) => ({ stride, ssimMin8: ssim, meshRawBytes: 1, heightOnlyRawBytes: 1 });
  const mk = (ssims) => ({
    dem: 'x:1', group: 'g',
    options: { rule: { bounds: [0, 0.25, 0.25, 0.25], levels: [lv(1, 1), ...ssims.map((v, k) => lv(2 ** (k + 1), v))] } },
  });
  const run = (ssims) => formatB6({ ssimMin: 0.95, initialLimitBytes: 1, results: [mk(ssims)] });
  const failOf = (txt) => Number(/\| (\d+)\/3 \|/.exec(txt.split('\n').find((x) => x.startsWith('g | rule')))[1]);
  assert.equal(failOf(run([0.99, 0.99, 0.99])), 0);
  assert.ok(failOf(run([0.99, NaN, 0.99])) >= 1);
  assert.equal(failOf(run([0.99, 0.5, 0.99])), 1);
});
