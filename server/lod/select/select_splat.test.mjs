// F-126: LOD 선택(selectLevels·selectWithBudget·leafTargets·progressiveChunks)은 opts.pointSizeM(래스터 원판 지름 m)을 받으면
// 컬링 절두체와 같은 boxMayBeVisibleSplat(좌·우·위·아래 평면을 원판 반경 m = fx·pointSizeM/2 만큼 민 판정)을 쓴다.
// 없으면 원판 중심 규칙 그대로다. 반례는 F-116 과 같다(960×540, 깊이 1 m, u = −1, sizeM 0.05, r = 18.858 px).
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { buildHierarchy, selectLevels } from './index.mjs';
import { selectWithBudget, leafTargets } from '../budget/index.mjs';
import { progressiveChunks } from '../progressive/index.mjs';

const W = 960, H = 540;
const CAM = { width: W, height: H, K: { fx: 754.32, fy: 753.85, cx: 480, cy: 270 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const SIZE_M = 0.05;
const R_PX = (CAM.K.fx * SIZE_M) / 2; // 깊이 1 m 의 원판 반경 18.858 px
const TAU = 1;

// 깊이 d 에서 픽셀 (u, v) 로 투영되는 점(R = I, t = 0)
const unproject = (u, v, d) => [((u - CAM.K.cx) * d) / CAM.K.fx, ((v - CAM.K.cy) * d) / CAM.K.fy, d];

// 점 하나 = 리프 하나 = 노드 하나인 계약상 올바른 계층(단계 1개). 리프 상자는 점 자체(꼭 맞는 상자, 가장 엄격한 경우).
function onePointHierarchy(p) {
  const positions = Float32Array.from(p);
  const cloud = { format: 1, count: 1, positions, normals: Float32Array.from([0, 0, -1]), colors: Uint8Array.from([200, 200, 200]) };
  const one = () => Uint32Array.from([0, 1]);
  return {
    cloud,
    edge0M: 0.05,
    octree: {
      nodeCount: 1, leafCount: 1, firstChild: Int32Array.from([-1]), childCount: new Uint8Array(1), leafIndex: Int32Array.from([0]),
      boxMin: positions.slice(), boxMax: positions.slice(), leafStart: one(), order: Uint32Array.from([0]),
    },
    levels: [{ level: 0, edgeM: 0.05, count: 1, indices: Uint32Array.from([0]), leafStart: one(), positions: positions.slice(), normals: cloud.normals.slice(), colors: cloud.colors.slice() }],
  };
}

const rasterPixels = (h) => {
  const res = renderPoints(CAM, h.cloud, { pointSizeM: SIZE_M });
  let px = 0;
  for (let i = 0; i < res.index.length; i++) if (res.index[i] >= 0) px++;
  return px;
};

test('F-116 반례(깊이 1 m, u = −1): 래스터는 524 픽셀을 그리고, pointSizeM 0.05 를 주면 세 진입점 모두 리프를 남긴다', () => {
  const h = onePointHierarchy(unproject(-1, H / 2, 1));
  assert.equal(rasterPixels(h), 524, '참조 래스터가 그린 픽셀(구운 값, culling_F116.md 와 같음)');

  const sel = selectLevels(h, CAM, { thresholdPx: TAU, pointSizeM: SIZE_M });
  assert.notEqual(sel.leafLevel[0], NOT_DRAWN, 'selectLevels: 원판이 화면에 걸친 리프는 그린다');
  assert.equal(sel.leafLevel[0], 0);
  assert.equal(sel.pointCount, 1);

  const b = selectWithBudget(h, CAM, { thresholdPx: TAU, budgetPoints: 10, pointSizeM: SIZE_M });
  assert.equal(b.leafLevel[0], 0, 'selectWithBudget');
  assert.equal(b.pointCount, 1);
  assert.equal(leafTargets(h, CAM, TAU, { pointSizeM: SIZE_M }).visible[0], 1, 'leafTargets');

  const ch = progressiveChunks(h, CAM, { thresholdPx: TAU, pointSizeM: SIZE_M });
  assert.deepEqual(ch.map((c) => [c.level, c.leaf, Array.from(c.indices)]), [[0, 0, [0]]], 'progressiveChunks');
});

test('같은 반례에서 pointSizeM 이 없거나 0 이면 기존 원판 중심 규칙(NOT_DRAWN) 그대로', () => {
  const h = onePointHierarchy(unproject(-1, H / 2, 1));
  for (const o of [{}, { pointSizeM: 0 }]) {
    const sel = selectLevels(h, CAM, { thresholdPx: TAU, ...o });
    assert.equal(sel.leafLevel[0], NOT_DRAWN);
    assert.equal(sel.pointCount, 0);
    assert.equal(selectWithBudget(h, CAM, { thresholdPx: TAU, budgetPoints: 10, ...o }).leafLevel[0], NOT_DRAWN);
    assert.equal(progressiveChunks(h, CAM, { thresholdPx: TAU, ...o }).length, 0);
  }
});

test('원판 반경 바로 바깥(u = −r − 0.5)은 래스터 0 픽셀이고 pointSizeM 을 줘도 NOT_DRAWN', () => {
  const h = onePointHierarchy(unproject(-R_PX - 0.5, H / 2, 1));
  assert.equal(rasterPixels(h), 0);
  assert.equal(selectLevels(h, CAM, { thresholdPx: TAU, pointSizeM: SIZE_M }).leafLevel[0], NOT_DRAWN);
  assert.equal(selectWithBudget(h, CAM, { thresholdPx: TAU, budgetPoints: 10, pointSizeM: SIZE_M }).leafLevel[0], NOT_DRAWN);
  assert.equal(progressiveChunks(h, CAM, { thresholdPx: TAU, pointSizeM: SIZE_M }).length, 0);
});

test('네 가장자리(위·아래·오른쪽 포함) 반경 안 점도 pointSizeM 을 주면 남는다', () => {
  for (const [u, v] of [[W + 1, H / 2], [W / 2, -1], [W / 2, H + 1]]) {
    const h = onePointHierarchy(unproject(u, v, 1));
    assert.ok(rasterPixels(h) > 0, `래스터가 그림 (${u}, ${v})`);
    assert.equal(selectLevels(h, CAM, { thresholdPx: TAU }).leafLevel[0], NOT_DRAWN, `중심 규칙은 버림 (${u}, ${v})`);
    assert.equal(selectLevels(h, CAM, { thresholdPx: TAU, pointSizeM: SIZE_M }).leafLevel[0], 0, `원판 규칙은 남김 (${u}, ${v})`);
  }
});

test('잘못된 pointSizeM(null·음수·NaN·Infinity·문자열)은 세 진입점 모두 lod: 오류', () => {
  const h = onePointHierarchy(unproject(-1, H / 2, 1));
  for (const bad of [null, -0.01, NaN, Infinity, '0.05']) {
    assert.throws(() => selectLevels(h, CAM, { thresholdPx: TAU, pointSizeM: bad }), /^Error: lod: pointSizeM/);
    assert.throws(() => selectWithBudget(h, CAM, { thresholdPx: TAU, budgetPoints: 10, pointSizeM: bad }), /^Error: lod: pointSizeM/);
    assert.throws(() => progressiveChunks(h, CAM, { thresholdPx: TAU, pointSizeM: bad }), /^Error: lod: pointSizeM/);
  }
});

test('실제 장면: pointSizeM 은 리프를 더할 뿐, 원래 그리던 리프의 단계는 바꾸지 않는다(select·budget 무예산·progressive)', () => {
  const { cloud } = generate({ seed: 3, count: 20000 });
  const h = buildHierarchy(cloud, { edge0M: 0.25, levelCount: 4, maxLeafPoints: 128 });
  const views = [
    { eye: [0, 120, 140], target: [0, 5, 0] },
    { eye: [30, 8, 30], target: [-20, 5, -10] },
    { eye: [-5, 3, 0], target: [40, 2, 5] },
  ];
  let added = 0;
  for (const vp of views) {
    const cam = viewpointToCamera({ ...vp, up: [0, 1, 0], fov_y_deg: 50, width: 320, height: 240 });
    const a = selectLevels(h, cam, { thresholdPx: TAU });
    const b = selectLevels(h, cam, { thresholdPx: TAU, pointSizeM: 0.5 });
    for (let k = 0; k < a.leafLevel.length; k++) {
      if (a.leafLevel[k] !== NOT_DRAWN) assert.equal(b.leafLevel[k], a.leafLevel[k], `리프 ${k} 단계 불변`);
      else if (b.leafLevel[k] !== NOT_DRAWN) added++;
    }
    assert.ok(b.pointCount >= a.pointCount);
    const ba = selectWithBudget(h, cam, { thresholdPx: TAU, budgetPoints: 1e9 });
    const bb = selectWithBudget(h, cam, { thresholdPx: TAU, budgetPoints: 1e9, pointSizeM: 0.5 });
    assert.deepEqual(ba.leafLevel, a.leafLevel, 'budget(무예산) = select (pointSizeM 없음)');
    assert.deepEqual(bb.leafLevel, b.leafLevel, 'budget(무예산) = select (pointSizeM 있음)');
    const pa = new Set(progressiveChunks(h, cam, { thresholdPx: TAU }).map((c) => c.leaf));
    const pb = new Set(progressiveChunks(h, cam, { thresholdPx: TAU, pointSizeM: 0.5 }).map((c) => c.leaf));
    for (const k of pa) assert.ok(pb.has(k));
    for (let k = 0; k < b.leafLevel.length; k++) assert.equal(pb.has(k), b.leafLevel[k] !== NOT_DRAWN, `progressive 리프 집합 = select (리프 ${k})`);
  }
  assert.ok(added > 0, `원판 여유로 새로 남은 리프가 있어야 판별력이 있음 (added=${added})`);
});
