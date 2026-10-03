import test from 'node:test';
import assert from 'node:assert/strict';
import { cullAndSelectDefault } from '../../server/cull/combine/index.mjs';
import { measureCullCost, measureCullCostAsync, getStats } from './index.mjs';
import { generate as generateTerrain } from '../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';
import { buildBenchHierarchy, buildRemovalScene, makeCameras, makeRealStages, measureScene, tableRow, STAGE_NAMES, REAL_MODULES } from './real_stages.mjs';

// 테스트용 카메라 생성
function createTestCamera(options = {}) {
  const {
    width = 800,
    height = 600,
    fx = 400,
    fy = 400,
    cx = 400,
    cy = 300,
    R = [1, 0, 0, 0, 1, 0, 0, 0, 1],
    t = [0, 0, -10],
  } = options;
  return { width, height, K: { fx, fy, cx, cy }, R, t };
}

test('컬링 비용 측정: 입력 검증 - hierarchy 누락', () => {
  const cameras = [createTestCamera()];
  assert.throws(() => measureCullCost(null, cameras), /cull:/);
});

test('컬링 비용 측정: 입력 검증 - cameras 비어있음', () => {
  const scene = generateTerrain({ seed: 42, count: 10000 });
  const hierarchy = buildHierarchy(scene.cloud, { edge0M: 0.3, levelCount: 2 });
  assert.throws(() => measureCullCost(hierarchy, []), /cull:/);
});

test('컬링 비용 측정: 입력 검증 - repeats 오류', () => {
  const scene = generateTerrain({ seed: 42, count: 10000 });
  const hierarchy = buildHierarchy(scene.cloud, { edge0M: 0.3, levelCount: 2 });
  const cameras = [createTestCamera()];
  assert.throws(() => measureCullCost(hierarchy, cameras, { repeats: 0 }), /cull:/);
  assert.throws(() => measureCullCost(hierarchy, cameras, { repeats: -1 }), /cull:/);
  assert.throws(() => measureCullCost(hierarchy, cameras, { repeats: 1.5 }), /cull:/);
});

// ---- 결정적 시간 스텁: 단계 함수가 가짜 시계를 정해진 ms 만큼 앞으로 돌린다 ----
function fakeClock() {
  let t = 1000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
// durations[name] = 호출 순서대로 걸리는 ms 목록. 단계는 자기 호출 횟수째 값만큼 시계를 돌린다.
function scriptedStages(clock, durations) {
  const calls = {};
  const stages = {};
  for (const name of Object.keys(durations)) {
    calls[name] = 0;
    stages[name] = () => { clock.advance(durations[name][calls[name]++]); };
  }
  return stages;
}
const dummyHierarchy = { octree: { leafCount: 1 } };
const oneCam = [createTestCamera()];

test('통계: getStats 는 median·p95·max 를 정확히 낸다', () => {
  // 홀수 5개: median 은 가운데
  assert.deepEqual(getStats([5, 1, 4, 2, 3]), { median: 3, p95: 5, max: 5 });
  // 짝수 4개: median 은 가운데 둘의 평균(2.5), min(1)이 아니다
  assert.deepEqual(getStats([4, 1, 3, 2]), { median: 2.5, p95: 4, max: 4 });
  // 20개: p95 = 19번째(올림 순위), max = 20 과 달라야 한다
  const twenty = Array.from({ length: 20 }, (_, k) => k + 1).reverse();
  assert.deepEqual(getStats(twenty), { median: 10.5, p95: 19, max: 20 });
  // 1개
  assert.deepEqual(getStats([7]), { median: 7, p95: 7, max: 7 });
  assert.deepEqual(getStats([]), { median: 0, p95: 0, max: 0 });
});

test('측정: 단계 시간은 단계마다 따로, 시점 시간은 모든 단계의 합(누적·마지막 단계만 아님)', () => {
  const clock = fakeClock();
  const stages = scriptedStages(clock, { a: [1, 1, 1], b: [2, 2, 2], c: [4, 4, 4] });
  const r = measureCullCost(dummyHierarchy, oneCam, { stages, repeats: 3, now: clock.now });
  // 단계 a=1, b=2, c=4 (앞 단계 시간이 쌓이면 b=3·c=7 이 된다)
  assert.deepEqual(r.perStageMs.a, { median: 1, p95: 1, max: 1 });
  assert.deepEqual(r.perStageMs.b, { median: 2, p95: 2, max: 2 });
  assert.deepEqual(r.perStageMs.c, { median: 4, p95: 4, max: 4 });
  // 시점 = 1+2+4 (마지막 단계만이면 4)
  assert.deepEqual(r.perViewMs, { median: 7, p95: 7, max: 7 });
});

test('측정: 시점별·반복별로 따로 기록하고 median·p95·max 가 서로 다르다', () => {
  const clock = fakeClock();
  // 20 표본(카메라 2 × 반복 10). 단계 x 는 1..20 ms, 단계 y 는 항상 100 ms.
  const xs = Array.from({ length: 20 }, (_, k) => k + 1);
  const stages = scriptedStages(clock, { x: xs, y: new Array(20).fill(100) });
  const cams = [createTestCamera(), createTestCamera({ t: [1, 2, 3] })];
  const r = measureCullCost(dummyHierarchy, cams, { stages, repeats: 10, now: clock.now });
  assert.deepEqual(r.perStageMs.x, { median: 10.5, p95: 19, max: 20 });
  assert.deepEqual(r.perStageMs.y, { median: 100, p95: 100, max: 100 });
  // 시점 합: 101..120 → median 110.5, p95 119, max 120
  assert.deepEqual(r.perViewMs, { median: 110.5, p95: 119, max: 120 });
});

test('측정: 짝수 표본의 median 은 가운데 둘의 평균', () => {
  const clock = fakeClock();
  const stages = scriptedStages(clock, { s: [8, 2, 6, 4] });
  const r = measureCullCost(dummyHierarchy, oneCam, { stages, repeats: 4, now: clock.now });
  assert.deepEqual(r.perStageMs.s, { median: 5, p95: 8, max: 8 });
  assert.deepEqual(r.perViewMs, { median: 5, p95: 8, max: 8 });
});

test('측정: 비동기 변형도 같은 통계를 낸다(await 한 시간만, 단계별·합계)', async () => {
  const clock = fakeClock();
  const calls = { slow: 0, fast: 0 };
  const slowMs = [3, 9, 6];
  const stages = {
    slow: async () => { await Promise.resolve(); clock.advance(slowMs[calls.slow++]); },
    fast: async () => { await Promise.resolve(); clock.advance(1 + calls.fast++); },
  };
  const r = await measureCullCostAsync(dummyHierarchy, oneCam, { stages, repeats: 3, now: clock.now });
  assert.deepEqual(r.perStageMs.slow, { median: 6, p95: 9, max: 9 });
  assert.deepEqual(r.perStageMs.fast, { median: 2, p95: 3, max: 3 });
  // 시점 합: 4, 11, 9
  assert.deepEqual(r.perViewMs, { median: 9, p95: 11, max: 11 });
});

test('측정: now 가 함수가 아니면 오류', () => {
  assert.throws(() => measureCullCost(dummyHierarchy, oneCam, { now: 5 }), /cull:/);
});

test('실제 시계: 5ms busy-wait 단계는 4.5ms 이상 5ms 근처 위로 감지', () => {
  const stages = { slow: () => { const d = performance.now() + 5; while (performance.now() < d); } };
  const r = measureCullCost(dummyHierarchy, oneCam, { stages, repeats: 2 });
  assert.ok(r.perStageMs.slow.median >= 4.5, `median=${r.perStageMs.slow.median}`);
  assert.ok(r.perViewMs.median >= r.perStageMs.slow.median);
});

test('단계 이름 일치: perStageMs 키가 주어진 단계와 같다', () => {
  const stages = { frustum: () => {}, backface: () => {}, distance: () => {} };
  const r = measureCullCost(dummyHierarchy, oneCam, { stages, repeats: 1 });
  assert.deepEqual(Object.keys(r.perStageMs), ['frustum', 'backface', 'distance']);
});

// ---- 실제 단계 ----
test('실제 단계: frustum·backface·occlusion·priority 가 실제 모듈을 부르고 결과가 올바른 모양', () => {
  const { hierarchy, pointCount, leafCount } = buildBenchHierarchy(20000, 256);
  assert.equal(pointCount, 20000);
  assert.ok(leafCount >= 16, `leafCount=${leafCount}`);
  const cams = makeCameras();
  const stages = makeRealStages(hierarchy, cams);
  assert.deepEqual(Object.keys(stages), STAGE_NAMES);
  for (const cam of cams) {
    for (const name of ['frustum', 'backface', 'occlusion']) {
      const mask = stages[name](hierarchy, cam);
      assert.ok(mask instanceof Uint8Array && mask.length === leafCount, name);
      for (const v of mask) assert.ok(v === 0 || v === 1);
    }
    // frustum 은 가시 리프가 있고(전부 제거도 전부 유지도 아님 없이 최소 하나), priority 는 frustum 마스크의 리프만 정렬
    const fm = stages.frustum(hierarchy, cam);
    const kept = fm.reduce((a, b) => a + b, 0);
    assert.ok(kept > 0, '카메라가 장면을 보지 못함');
    const order = stages.priority(hierarchy, cam);
    assert.equal(order.length, kept);
    assert.ok(order.every((k) => fm[k] === 1));
  }
});

test('실제 측정: measureScene 은 단계 4개와 cullAndSelectDefault 를 모두 재고 표 행을 만든다', async () => {
  const { hierarchy, pointCount, leafCount } = buildBenchHierarchy(20000, 256);
  const cams = makeCameras();
  // 가짜 시계: 모든 now() 호출마다 1ms 씩 흘러 각 단계가 정확히 1ms 로 잡힌다(호출 쌍 = t0, 끝)
  let t = 0;
  const now = () => { const v = t; t += 1; return v; };
  const res = await measureScene(hierarchy, cams, { repeats: 2, now });
  assert.deepEqual(Object.keys(res.staged.perStageMs), STAGE_NAMES);
  for (const n of STAGE_NAMES) assert.deepEqual(res.staged.perStageMs[n], { median: 1, p95: 1, max: 1 });
  assert.deepEqual(res.staged.perViewMs, { median: 4, p95: 4, max: 4 });
  assert.deepEqual(Object.keys(res.combined.perStageMs), ['cullAndSelectDefault']);
  assert.deepEqual(tableRow(pointCount, leafCount, res), [
    '20000', String(leafCount), '1.00', '1.00', '1.00', '1.00', '4.00', '4.00', '1.00', '1.00', '4.00', '1.00',
  ]);
  // cold(첫 반복)와 warm 을 따로 보고한다
  assert.deepEqual(res.cold.staged.perViewMs, { median: 4, p95: 4, max: 4 });
  assert.deepEqual(res.cold.combined.perStageMs.cullAndSelectDefault, { median: 1, p95: 1, max: 1 });
});

test('실제 측정: 실제 시계로 재면 모든 단계가 양의 유한 시간이고 median ≤ p95 ≤ max', async () => {
  const { hierarchy } = buildBenchHierarchy(50000, 128);
  const res = await measureScene(hierarchy, makeCameras(), { repeats: 3 });
  const all = [res.staged.perViewMs, ...Object.values(res.staged.perStageMs), res.combined.perViewMs];
  for (const s of all) {
    assert.ok(Number.isFinite(s.max) && s.max > 0);
    assert.ok(s.median <= s.p95 && s.p95 <= s.max);
  }
  // 합은 단계 하나보다 크다
  assert.ok(res.staged.perViewMs.median > res.staged.perStageMs.occlusion.median);
});

// ---- 제거가 실제로 일어나는 장면(F-128③) ----
// 가짜 시계는 now() 호출 수만 세므로 단계가 무엇을 하든 1.00 이다. 그래서 이 장면에서는 시계와 무관한 사실을 단언한다:
// 뒷면·가림이 실제로 제거를 하고, 각 단계가 정해진 횟수만 불리며, 실제 모듈이 {pointSizeM} 을 받았고, 한 호출이 비정상적으로 오래 걸리지 않는다.
const CAMERAS_PER_PASS = 4; // REMOVAL_SCENE.viewNames 길이
const CALL_CEILING_MS = 1000; // 측정 구간 하나의 실제 시간 상한(멈춘 단계·의도치 않은 대기를 잡는 생존 한계)

function spyModules(log) {
  const spy = (name, optsIndex) => (...args) => { log.push({ fn: name, pointSizeM: args[optsIndex]?.pointSizeM }); return REAL_MODULES[name](...args); };
  return {
    ...REAL_MODULES,
    frustumCull: spy('frustumCull', 2),
    backfaceCull: spy('backfaceCull', 3),
    buildDepthPyramid: spy('buildDepthPyramid', 2),
  };
}

let removalScene;
const getRemovalScene = () => (removalScene ??= buildRemovalScene());

test('제거 장면: 뒷면 후보와 가림 제거가 모든 시점에서 0 보다 크다(단계 마스크 직접 확인)', () => {
  const { hierarchy, cameras, pointSizeM } = getRemovalScene();
  const stages = makeRealStages(hierarchy, cameras, { pointSizeM });
  assert.equal(cameras.length, CAMERAS_PER_PASS);
  for (const cam of cameras) {
    const fm = stages.frustum(hierarchy, cam);
    for (const name of ['backface', 'occlusion']) {
      const m = stages[name](hierarchy, cam);
      let removed = 0;
      for (let k = 0; k < m.length; k++) if (fm[k] === 1 && m[k] === 0) removed++;
      assert.ok(removed > 0, `${name}: 절두체를 통과한 리프 중 제거 0`);
    }
  }
});

test('제거 장면: measureScene 이 모듈 호출·pointSizeM 전달·제거 수·cold/warm 을 모두 보고한다', async () => {
  const { hierarchy, cameras, pointSizeM, thresholdPx } = getRemovalScene();
  const modLog = [];
  let tick = 0;
  const now = () => tick++; // 호출 수만 세는 시계
  const res = await measureScene(hierarchy, cameras, { repeats: 2, now, pointSizeM, thresholdPx, modules: spyModules(modLog) });

  // 시계와 무관: 제거가 실제로 일어났다(결합 경로의 단계별 새 제거 합)
  assert.ok(res.removal.backface > 0, `뒷면 제거 ${res.removal.backface}`);
  assert.ok(res.removal.occlusion > 0, `가림 제거 ${res.removal.occlusion}`);

  // 결합 경로: 단계 구현 호출마다 opts.pointSizeM 이 cullAndSelect 에 준 값 그대로, 단계마다 (cold 1 + warm 2) × 시점 수 번
  const passes = (1 + 2) * CAMERAS_PER_PASS;
  for (const stage of ['frustum', 'backface', 'occlusion', 'distance']) {
    const c = res.calls.filter((x) => x.stage === stage);
    assert.equal(c.length, passes, `${stage} 호출 수`);
    for (const x of c) assert.equal(x.pointSizeM, pointSizeM, `${stage} 가 받은 pointSizeM`);
  }

  // 단계 경로: 실제 모듈이 {pointSizeM} 을 받았다. frustum 은 준비(마스크 1회)+단계(cold1+warm2) 마다, 가림 피라미드는 단계마다.
  for (const [fn, n] of [['frustumCull', CAMERAS_PER_PASS * (1 + 1 + 2)], ['backfaceCull', passes], ['buildDepthPyramid', passes]]) {
    const c = modLog.filter((x) => x.fn === fn);
    assert.equal(c.length, n, `${fn} 호출 수`);
    for (const x of c) assert.equal(x.pointSizeM, pointSizeM, `${fn} 가 받은 pointSizeM`);
  }

  // cold 와 warm 은 따로 보고된다(표본 수가 다르다)
  assert.deepEqual(Object.keys(res.cold.staged.perStageMs), STAGE_NAMES);
  assert.deepEqual(Object.keys(res.cold.combined.perStageMs), ['cullAndSelectDefault']);
  // 가짜 시계에서 단계 하나는 호출 쌍 1틱 = 1
  for (const n of STAGE_NAMES) assert.deepEqual(res.staged.perStageMs[n], { median: 1, p95: 1, max: 1 });
  assert.deepEqual(res.combined.perStageMs.cullAndSelectDefault, { median: 1, p95: 1, max: 1 });
});

test('제거 장면: 결합 경로(기본 구현)의 단계별 제거 수가 pointSizeM 을 직접 넘긴 실제 모듈 결과와 같다', async () => {
  // 결합 경로가 기본 구현 안에서 모듈에 pointSizeM 을 못 넘기면(기본 지름으로 대체) 제거 수가 달라진다.
  const { hierarchy, cameras, pointSizeM, thresholdPx } = getRemovalScene();
  const stages = makeRealStages(hierarchy, cameras, { pointSizeM });
  for (const cam of cameras) {
    const r = await cullAndSelectDefault(hierarchy, cam, { thresholdPx, pointSizeM, stages: ['frustum', 'backface', 'occlusion'] });
    let acc = new Uint8Array(hierarchy.octree.leafCount).fill(1);
    const expected = {};
    for (const [name, key] of [['frustum', 'removedFrustum'], ['backface', 'removedBackface'], ['occlusion', 'removedOcclusion']]) {
      const m = stages[name](hierarchy, cam);
      let removed = 0;
      for (let k = 0; k < acc.length; k++) if (acc[k] === 1 && m[k] === 0) removed++;
      expected[key] = removed;
      acc = acc.map((v, k) => v & m[k]);
    }
    assert.ok(expected.removedBackface > 0 && expected.removedOcclusion > 0);
    for (const key of Object.keys(expected)) assert.equal(r.cull.stats[key], expected[key], key);
  }
});

test('제거 장면: 측정 구간(now 호출 쌍) 하나의 실제 시간이 생존 한계(1000 ms)를 넘지 않는다(가짜 시계가 못 보는 대기 방지)', async () => {
  const { hierarchy, cameras, pointSizeM, thresholdPx } = getRemovalScene();
  // 보고는 틱(호출 수), 감시는 실제 시간: now() 호출 (t0, 끝) 쌍마다 실제 경과를 잰다.
  let tick = 0;
  const wall = [];
  const now = () => { wall.push(performance.now()); return tick++; };
  await measureScene(hierarchy, cameras, { repeats: 1, now, pointSizeM, thresholdPx });
  assert.equal(wall.length % 2, 0);
  const spans = [];
  for (let i = 0; i < wall.length; i += 2) spans.push(wall[i + 1] - wall[i]);
  assert.ok(spans.length > 0);
  assert.ok(Math.max(...spans) < CALL_CEILING_MS, `가장 긴 측정 구간 ${Math.max(...spans).toFixed(0)} ms`);
});
