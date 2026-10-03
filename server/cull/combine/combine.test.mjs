// T08.8 cullAndSelect 단위 시험: 주입 스텁 마스크, 통계(단계별 '새로 제거한 수'), 입력 오류('cull:'), 퇴화 시점, 우선순위 정렬.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { buildHierarchy, selectLevels, materialize } from '../../lod/select/index.mjs';
import { cullAndSelect, DEFAULT_STAGES } from './index.mjs';

const cloud = generate({ seed: 2, count: 40000 }).cloud;
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 4, maxLeafPoints: 512 });
const L = h.octree.leafCount;
const cam = viewpointToCamera({ eye: [-120, 60, -120], target: [0, 10, 0], up: [0, 1, 0], width: 160, height: 90, fov_y_deg: 70 });
const TAU = 0.5;
const ones = () => new Uint8Array(L).fill(1);
const without = (...ks) => () => { const m = ones(); for (const k of ks) m[k] = 0; return m; };
const allOnes = { frustum: ones, backface: ones, occlusion: ones, distance: ones };
const lod = selectLevels(h, cam, { thresholdPx: TAU });
const leafPts = (sel, k) => (sel.leafLevel[k] === NOT_DRAWN ? 0 : h.levels[sel.leafLevel[k]].leafStart[k + 1] - h.levels[sel.leafLevel[k]].leafStart[k]);
// 그려지는(LOD 단계가 있는) 리프 몇 개
const drawn = [...lod.leafLevel.keys()].filter((k) => lod.leafLevel[k] !== NOT_DRAWN);

test('준비: 리프가 충분하고 LOD 가 일부 리프를 그림', () => {
  assert.ok(L >= 40, `리프 ${L}`);
  assert.ok(drawn.length >= 10);
});

test('모두 1 마스크: 선택이 LOD 만일 때와 같고 조각 = 전체 리프', () => {
  const r = cullAndSelect(h, cam, { thresholdPx: TAU, stageImpls: allOnes });
  assert.deepEqual([...r.selection.leafLevel], [...lod.leafLevel]);
  assert.equal(r.selection.pointCount, lod.pointCount);
  assert.equal(r.cull.chunks.length, L);
  assert.deepEqual(r.cull.stats, { leafCount: L, kept: L, removedFrustum: 0, removedBackface: 0, removedOcclusion: 0, removedDistance: 0 });
});

test('일부 0 마스크: 0 리프는 NOT_DRAWN, 1 리프 단계는 그대로, 점 수 재계산·비증가', () => {
  const cut = drawn.slice(0, 5);
  const r = cullAndSelect(h, cam, { thresholdPx: TAU, stageImpls: { ...allOnes, backface: without(...cut) } });
  let expectPts = lod.pointCount;
  for (const k of cut) expectPts -= leafPts(lod, k);
  for (let k = 0; k < L; k++) {
    if (cut.includes(k)) { assert.equal(r.cull.mask[k], 0); assert.equal(r.selection.leafLevel[k], NOT_DRAWN); }
    else assert.equal(r.selection.leafLevel[k], lod.leafLevel[k]);
  }
  assert.equal(r.selection.pointCount, expectPts);
  assert.ok(expectPts < lod.pointCount);
  assert.equal(materialize(h, r.selection).count, expectPts);
  assert.equal(r.cull.chunks.length, L - 5);
  assert.deepEqual([...r.cull.chunks], [...Array(L).keys()].filter((k) => !cut.includes(k)));
});

test('통계: 단계 순서대로 그 단계가 새로 제거한 수(겹친 제거는 앞 단계 몫)', () => {
  const r = cullAndSelect(h, cam, {
    thresholdPx: TAU, maxDistanceM: 1000,
    stageImpls: { frustum: without(0, 1, 2), backface: without(1, 2, 3), occlusion: without(0, 3), distance: without(4, 5, 0) },
  });
  assert.deepEqual(r.cull.stats, { leafCount: L, kept: L - 6, removedFrustum: 3, removedBackface: 1, removedOcclusion: 0, removedDistance: 2 });
  // 단계 순서를 바꾸면 몫이 바뀐다
  const r2 = cullAndSelect(h, cam, {
    thresholdPx: TAU, stages: ['distance', 'occlusion', 'backface', 'frustum'], maxDistanceM: 1000,
    stageImpls: { frustum: without(0, 1, 2), backface: without(1, 2, 3), occlusion: without(0, 3), distance: without(4, 5, 0) },
  });
  assert.deepEqual(r2.cull.stats, { leafCount: L, kept: L - 6, removedFrustum: 0, removedBackface: 2, removedOcclusion: 1, removedDistance: 3 });
});

test('stages 부분집합: 실행 안 한 단계는 호출되지 않고 0', () => {
  let called = 0;
  const boom = () => { called++; return new Uint8Array(L); };
  const r = cullAndSelect(h, cam, { thresholdPx: TAU, stages: ['frustum'], stageImpls: { frustum: without(7), backface: boom } });
  assert.equal(called, 0);
  assert.equal(r.cull.stats.removedFrustum, 1);
  assert.equal(r.cull.stats.removedBackface, 0);
  // 빈 stages: 아무것도 빼지 않음
  const r0 = cullAndSelect(h, cam, { thresholdPx: TAU, stages: [], stageImpls: {} });
  assert.equal(r0.cull.chunks.length, L);
  assert.equal(r0.selection.pointCount, lod.pointCount);
});

test('단계에 opts(maxDistanceM·thresholdPx) 가 전달됨', () => {
  let seen;
  cullAndSelect(h, cam, { thresholdPx: TAU, stages: ['distance'], maxDistanceM: 250, stageImpls: { distance: (hh, c, o) => { seen = o; return ones(); } } });
  assert.equal(seen.maxDistanceM, 250);
  assert.equal(seen.thresholdPx, TAU);
});

test('prioritize: orderChunks 순서를 그대로 쓰고 남은 리프의 순열인지 검사', () => {
  const rev = (hh, c, m) => Uint32Array.from([...m.keys()].filter((k) => m[k]).reverse());
  const r = cullAndSelect(h, cam, { thresholdPx: TAU, prioritize: true, orderChunks: rev, stageImpls: { ...allOnes, frustum: without(0) } });
  assert.equal(r.cull.chunks[0], L - 1);
  assert.equal(r.cull.chunks.length, L - 1);
  assert.throws(() => cullAndSelect(h, cam, { thresholdPx: TAU, prioritize: true, orderChunks: () => new Uint32Array(L), stageImpls: allOnes }), /^Error: cull:/);
  assert.throws(() => cullAndSelect(h, cam, { thresholdPx: TAU, prioritize: true, orderChunks: () => Uint32Array.from([...Array(L).keys()]), stageImpls: { ...allOnes, frustum: without(0) } }), /^Error: cull:/);
  assert.throws(() => cullAndSelect(h, cam, { thresholdPx: TAU, prioritize: true, stageImpls: allOnes }), /^Error: cull: prioritize/);
});

test('단계 구현이 없으면 Promise 가 아니라 명시 오류', () => {
  assert.throws(() => cullAndSelect(h, cam, { thresholdPx: TAU }), /^Error: cull: 단계 구현이 필요/);
  assert.throws(() => cullAndSelect(h, cam, { thresholdPx: TAU, stageImpls: { frustum: ones } }), /^Error: cull: 단계 구현이 필요: stageImpls\.backface/);
  assert.deepEqual([...DEFAULT_STAGES], ['frustum', 'backface', 'occlusion', 'distance']);
});

test('입력 오류는 cull: 로 시작', () => {
  const ok = { thresholdPx: TAU, stageImpls: allOnes };
  const bad = [
    () => cullAndSelect(null, cam, ok),
    () => cullAndSelect({ ...h, levels: [] }, cam, ok),
    () => cullAndSelect(h, null, ok),
    () => cullAndSelect(h, { ...cam, R: [1, 0, 0] }, ok),
    () => cullAndSelect(h, { ...cam, K: undefined }, ok),
    () => cullAndSelect(h, cam, null),
    () => cullAndSelect(h, cam, { ...ok, thresholdPx: 0 }),
    () => cullAndSelect(h, cam, { ...ok, thresholdPx: NaN }),
    () => cullAndSelect(h, cam, { ...ok, maxDistanceM: -1 }),
    () => cullAndSelect(h, cam, { ...ok, stages: ['frustum', 'frustum'] }),
    () => cullAndSelect(h, cam, { ...ok, stages: ['nope'] }),
    () => cullAndSelect(h, cam, { ...ok, stages: 'frustum' }),
    () => cullAndSelect(h, cam, { ...ok, prioritize: 1 }),
    () => cullAndSelect(h, cam, { ...ok, stageImpls: { ...allOnes, frustum: () => new Uint8Array(L - 1) } }),
    () => cullAndSelect(h, cam, { ...ok, stageImpls: { ...allOnes, frustum: () => new Uint8Array(L).fill(2) } }),
  ];
  for (const f of bad) assert.throws(f, /^Error: cull:/);
});

test('퇴화 시점(NaN 카메라 등): 던지지 않고 빈 선택, 단계는 호출되지 않음', () => {
  let called = 0;
  const spy = () => { called++; return ones(); };
  const cams = [
    { ...cam, t: [NaN, 0, 0] },
    { ...cam, R: cam.R.map(() => NaN) },
    { ...cam, K: { ...cam.K, fx: Infinity } },
    { ...cam, K: { ...cam.K, fy: 0 } },
    { ...cam, width: 0 },
    { ...cam, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] },
    { ...cam, R: [-1, 0, 0, 0, 1, 0, 0, 0, 1] },
  ];
  for (const c of cams) {
    const r = cullAndSelect(h, c, { thresholdPx: TAU, prioritize: true, orderChunks: spy, stageImpls: { frustum: spy, backface: spy, occlusion: spy, distance: spy } });
    assert.equal(r.selection.pointCount, 0);
    assert.equal(r.selection.leafLevel.length, L);
    assert.ok(r.selection.leafLevel.every((l) => l === NOT_DRAWN));
    assert.ok(r.cull.mask.every((m) => m === 0));
    assert.equal(r.cull.chunks.length, 0);
    assert.equal(r.cull.stats.kept, 0);
    assert.equal(r.cull.stats.degenerate, true);
    assert.equal(materialize(h, r.selection).count, 0);
  }
  assert.equal(called, 0);
});

test('주입한 isDegenerateView 를 쓴다', () => {
  const r = cullAndSelect(h, cam, { thresholdPx: TAU, stageImpls: allOnes, isDegenerateView: () => true });
  assert.equal(r.selection.pointCount, 0);
  const r2 = cullAndSelect(h, cam, { thresholdPx: TAU, stageImpls: allOnes, isDegenerateView: () => false });
  assert.equal(r2.selection.pointCount, lod.pointCount);
});

test('지면 아래 카메라는 퇴화가 아님(정상 처리)', () => {
  const below = viewpointToCamera({ eye: [0, -50, 0.01], target: [0, 0, 0], up: [0, 1, 0], width: 160, height: 90, fov_y_deg: 70 });
  const r = cullAndSelect(h, below, { thresholdPx: TAU, stageImpls: allOnes });
  assert.equal(r.cull.stats.degenerate, undefined);
  assert.equal(r.selection.pointCount, selectLevels(h, below, { thresholdPx: TAU }).pointCount);
});
