import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDistanceTable, levelForDistance, depthResolutionM, minEdge0M } from './index.mjs';
import { LOD_API, MAX_LEVELS } from '../../../contracts/lod/index.mjs';

// 기준값은 모두 손 계산한 숫자 리터럴이다(구현에서 다시 계산해 비교하지 않는다).

test('계약 표의 모듈 위치와 함수 이름', () => {
  assert.equal(LOD_API.distance_table.module, 'server/lod/distance_table/index.mjs');
  for (const name of ['buildDistanceTable', 'levelForDistance', 'depthResolutionM']) assert.ok(LOD_API.distance_table.fn.includes(name));
});

// 해석 예제: fx=800, τ=1, edge0=0.05 m
//   edgeM:        0.05, 0.1, 0.2, 0.4 m
//   maxDistanceM: 800·0.05/1 = 40, 800·0.1 = 80, 800·0.2 = 160, 800·0.4 = 320 m
test('해석 예제 fx=800, τ=1, edge0=0.05: 40/80/160/320 m', () => {
  const t = buildDistanceTable({ fx: 800, thresholdPx: 1, edge0M: 0.05, levelCount: 4 });
  assert.equal(t.levels.length, 4);
  assert.deepEqual(t.levels.map((x) => x.level), [0, 1, 2, 3]);
  assert.deepEqual(t.levels.map((x) => x.edgeM), [0.05, 0.1, 0.2, 0.4]);
  assert.deepEqual(t.levels.map((x) => x.maxDistanceM), [40, 80, 160, 320]);
  // 마지막 단계도 같은 식: Infinity 가 아니다
  assert.equal(t.levels[3].maxDistanceM, 320);
  assert.ok(Number.isFinite(t.levels[3].maxDistanceM));
  assert.equal(t.fx, 800);
  assert.equal(t.thresholdPx, 1);
  assert.equal(t.edge0M, 0.05);
});

test('해석 예제의 단계 선택과 경계 포함', () => {
  const t = buildDistanceTable({ fx: 800, thresholdPx: 1, edge0M: 0.05, levelCount: 4 });
  const cases = [
    [1, 0], [39.999, 0], [40, 0], // 40 m 미만은 만족하는 단계가 없어 원본 0
    [40.001, 0], [79.999, 0],
    [80, 1], [80.001, 1], [159.999, 1],
    [160, 2], [319.999, 2],
    [320, 3], [320.001, 3], [1e6, 3], // 마지막 단계는 위로 열려 있다
  ];
  for (const [d, l] of cases) assert.equal(levelForDistance(t, d), l, `d=${d}`);
});

// τ 를 2 로: 800·0.05/2 = 20, 40, 80 m
test('τ 가 커지면 거리가 반으로', () => {
  const t = buildDistanceTable({ fx: 800, thresholdPx: 2, edge0M: 0.05, levelCount: 3 });
  assert.deepEqual(t.levels.map((x) => x.maxDistanceM), [20, 40, 80]);
  assert.equal(levelForDistance(t, 39.9), 0);
  assert.equal(levelForDistance(t, 40), 1);
  assert.equal(levelForDistance(t, 80), 2);
});

// fx=1000, τ=4, edge0=0.25: edgeM 0.25, 0.5, 1, 2, 4 ; maxDistanceM 1000·0.25/4 = 62.5, 125, 250, 500, 1000
test('다른 손 계산 예: fx=1000, τ=4, edge0=0.25, 5단계', () => {
  const t = buildDistanceTable({ fx: 1000, thresholdPx: 4, edge0M: 0.25, levelCount: 5 });
  assert.deepEqual(t.levels.map((x) => x.edgeM), [0.25, 0.5, 1, 2, 4]);
  assert.deepEqual(t.levels.map((x) => x.maxDistanceM), [62.5, 125, 250, 500, 1000]);
  assert.equal(levelForDistance(t, 62.5), 0);
  assert.equal(levelForDistance(t, 124.99), 0);
  assert.equal(levelForDistance(t, 125), 1);
  assert.equal(levelForDistance(t, 499.99), 2);
  assert.equal(levelForDistance(t, 500), 3);
  assert.equal(levelForDistance(t, 999.99), 3);
  assert.equal(levelForDistance(t, 1000), 4);
});

test('단계 1개: 언제나 0', () => {
  const t = buildDistanceTable({ fx: 800, thresholdPx: 1, edge0M: 0.05, levelCount: 1 });
  assert.deepEqual(t.levels.map((x) => x.maxDistanceM), [40]);
  for (const d of [0.001, 40, 1e9]) assert.equal(levelForDistance(t, d), 0);
});

test('선택 결과는 정의(f·edgeM(l)/d ≤ τ 인 가장 큰 l, 없으면 0)와 같다', () => {
  const fx = 754, tau = 1.5, edge0 = 0.03;
  const t = buildDistanceTable({ fx, thresholdPx: tau, edge0M: edge0, levelCount: 8 });
  for (let d = 0.5; d < 5000; d *= 1.037) {
    let want = 0;
    for (let l = 0; l < 8; l++) if ((fx * edge0 * 2 ** l) / d <= tau) want = l;
    assert.equal(levelForDistance(t, d), want, `d=${d}`);
  }
});

test('출력은 고정(frozen)', () => {
  const t = buildDistanceTable({ fx: 800, thresholdPx: 1, edge0M: 0.05, levelCount: 2 });
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.levels) && Object.isFrozen(t.levels[0]));
});

test('입력 검증: 비유한·0 이하·형식 오류는 lod: 오류', () => {
  const ok = { fx: 800, thresholdPx: 1, edge0M: 0.05, levelCount: 3 };
  const bad = [NaN, Infinity, -Infinity, 0, -1, '800', undefined, null];
  for (const k of ['fx', 'thresholdPx', 'edge0M']) {
    for (const v of bad) assert.throws(() => buildDistanceTable({ ...ok, [k]: v }), /^Error: lod:/, `${k}=${String(v)}`);
  }
  for (const v of [0, -1, 1.5, MAX_LEVELS + 1, NaN, Infinity, '3']) {
    assert.throws(() => buildDistanceTable({ ...ok, levelCount: v }), /^Error: lod:/, `levelCount=${String(v)}`);
  }
  assert.equal(buildDistanceTable({ ...ok, levelCount: MAX_LEVELS }).levels.length, MAX_LEVELS);
  assert.throws(() => buildDistanceTable(), /^Error: lod:/);
  assert.throws(() => buildDistanceTable(null), /^Error: lod:/);

  const t = buildDistanceTable(ok);
  for (const d of [0, -1, -0.001, NaN, Infinity, -Infinity, '40', undefined]) {
    assert.throws(() => levelForDistance(t, d), /^Error: lod:/, `d=${String(d)}`);
  }
  assert.throws(() => levelForDistance(null, 40), /^Error: lod:/);
  assert.throws(() => levelForDistance({ levels: [] }, 40), /^Error: lod:/);

  for (const args of [[0, 755, 1], [-1, 755, 1], [NaN, 755, 1], [Infinity, 755, 1],
    [45.3, 0, 1], [45.3, -755, 1], [45.3, NaN, 1], [45.3, Infinity, 1],
    [45.3, 755, 0], [45.3, 755, -1], [45.3, 755, NaN], [45.3, 755, Infinity]]) {
    assert.throws(() => depthResolutionM(...args), /^Error: lod:/, String(args));
    assert.throws(() => minEdge0M(...args), /^Error: lod:/, String(args));
  }
});

// Δd = d²/(f·b) 손 계산: 10²/(100·0.5) = 2 ; 20²/(800·2) = 0.25 ; 깊이 2배 → 4배
test('depthResolutionM 손 계산', () => {
  assert.equal(depthResolutionM(10, 100, 0.5), 2);
  assert.equal(depthResolutionM(20, 800, 2), 0.25);
  assert.equal(depthResolutionM(40, 800, 2), 1);
  assert.equal(depthResolutionM(20, 1600, 2), 0.125);
  assert.equal(depthResolutionM(20, 800, 4), 0.125);
});

// renderer_basis §3-7 표(d = 45.3 m): b=1.04 → 2.61 m, 4.14 → 0.66, 8.26 → 0.33, 15.37 → 0.18.
// f 역산: 표 값은 소수 둘째 자리 반올림이므로 각 행은 f ∈ [d²/(b·(Δ+0.005)), d²/(b·(Δ−0.005))] 를 준다.
//   1.04 m  → [754.56, 757.45]   (행 단독 역산 d²/(b·Δ) = 756.00)
//   4.14 m  → [745.37, 756.75]   (751.02)
//   8.26 m  → [741.60, 764.42]   (752.84)
//   15.37 m → [721.69, 762.93]   (741.74)
//   네 행의 교집합 = [754.56, 756.75] px. 그 안의 정수 f = 755 px 를 쓴다.
// 같은 문서 §1-2 의 K(fx = 754.32)와 §1-3 의 깊이 45.28 m 도 같은 표를 준다(아래 두 번째 시험).
// 표 머리의 d = 45.3 m 에서는 fx = 754.32 가 교집합 바로 밖이다(1행 2.6158 → 2.62). 따라서 표가 어느 (f, d) 로
// 계산됐는지는 문서만으로 하나로 정해지지 않으며, 두 해석(f=755·d=45.3 / fx=754.32·d=45.28)을 모두 시험한다.
const TABLE_F = 755;
const TABLE = [[1.04, 2.61], [4.14, 0.66], [8.26, 0.33], [15.37, 0.18]];

test('renderer_basis §3-7 표 재현 (d=45.3 m, f=755 px)', () => {
  for (const [b, want] of TABLE) {
    const got = minEdge0M(45.3, TABLE_F, b);
    assert.ok(Math.abs(got - want) <= 0.005, `b=${b}: ${got} vs ${want}`);
    assert.equal(Math.round(got * 100) / 100, want, `b=${b} 반올림`);
    assert.equal(got, depthResolutionM(45.3, TABLE_F, b));
  }
  // 손 계산 기준값(45.3² = 2052.09): 2052.09/(755·1.04) = 2.6135, /(755·15.37) = 0.17684
  assert.ok(Math.abs(minEdge0M(45.3, 755, 1.04) - 2.6135) < 1e-4);
  assert.ok(Math.abs(minEdge0M(45.3, 755, 15.37) - 0.17684) < 1e-5);
});

test('renderer_basis §3-7 표 재현, 해석 2: fx = 754.32 (§1-2), d = 45.28 m (§1-3)', () => {
  // 45.28² = 2050.2784 ; /(754.32·1.04) = 2.6135, /(754.32·4.14) = 0.65653, /(754.32·8.26) = 0.32906, /(754.32·15.37) = 0.17684
  for (const [b, want] of TABLE) {
    const got = minEdge0M(45.28, 754.32, b);
    assert.equal(Math.round(got * 100) / 100, want, `b=${b}: ${got}`);
    assert.equal(got, depthResolutionM(45.28, 754.32, b));
  }
  assert.ok(Math.abs(minEdge0M(45.28, 754.32, 1.04) - 2.6135) < 1e-4);
  assert.ok(Math.abs(minEdge0M(45.28, 754.32, 15.37) - 0.17684) < 1e-5);
});

test('f 역산 구간: 754.56~756.75 안은 네 행 모두 맞고, 밖(754.32, 757)은 어긋난다', () => {
  const fits = (f) => TABLE.every(([b, want]) => Math.round(depthResolutionM(45.3, f, b) * 100) / 100 === want);
  assert.ok(fits(754.6));
  assert.ok(fits(755));
  assert.ok(fits(756));
  assert.ok(fits(756.7));
  assert.equal(fits(754.32), false); // 문서 K 의 fx: 1행 2.62
  assert.equal(fits(754.5), false);
  assert.equal(fits(756.8), false);  // 2행 0.6549… → 0.65
});

test('edge0M 하한: 기선이 길수록 작아지고 깊이 제곱에 비례', () => {
  const a = minEdge0M(45.3, TABLE_F, 1.04), b = minEdge0M(45.3, TABLE_F, 8.26);
  assert.ok(a > b);
  assert.ok(Math.abs(minEdge0M(90.6, TABLE_F, 8.26) / b - 4) < 1e-12);
});
