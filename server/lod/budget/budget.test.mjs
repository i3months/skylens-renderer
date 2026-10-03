// T07.5 시험: 점 예산 상한 하 선택(selectWithBudget).
//
// 조건(값은 미리 정한 리터럴, 근거를 옆에 적는다):
//  - 장면 flat_boxes seed 1, 점 200000 개(장면 기본값). 바닥 200×200 m 에 약 5 점/m², 점 간격 ≈ 0.45 m.
//  - 계층: edge0M 0.25 m(원본 점 간격보다 촘촘해 단계 1 부터 실제로 줄어든다), levelCount 6(단계 5 칸 = 8 m,
//    상자 건물 폭 8~25 m 와 같은 크기까지), maxLeafPoints 2048(리프 수백 개 → 리프 단위 선택이 의미 있는 해상도).
//  - 시점: fixtures/viewpoints/synthetic.json 8곳. 원래 1280×720 을 320×180 으로 줄여 그린다(기록: 1280×720 에서는
//    예산 3종 × 시점 8 × (원본·선택·균일) 렌더와 SSIM 이 수십 초 걸려 시험이 느리다. 화각은 같고 fx 만 1/4).
//  - τ(thresholdPx) 1 px: 칸 하나가 1 픽셀 이하가 되는 거리부터 거칠게 한다(계약의 화면 오차 정의 그대로).
//  - 렌더 점 크기 pointSizeM 0.6 m: 원본 점 간격(≈0.45 m)보다 조금 커서 원본 렌더에 구멍이 거의 없다.
//    모든 렌더(원본·선택·비교 기준)가 같은 값을 써서 비교가 공정하다.
//  - 예산 3종: 큰 150000(모든 시점의 목표 단계 합 ≤ 144834 이므로 줄이지 않음), 중간 30000(탐욕적 거칠게 하기만으로 맞춤),
//    작은 600(단계 5 의 전체 점 수 2181 보다 작아 리프를 통째로 빼는 단계까지 감).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectWithBudget, leafTargets } from './index.mjs';
import { buildHierarchy } from '../hierarchy/index.mjs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { ssim } from '../../metrics/ssim/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';

const W = 320, H = 180;
const TAU = 1;
const POINT_SIZE_M = 0.6;
const BUDGETS = [150000, 30000, 600]; // 큰·중간·작은
const HIER = { edge0M: 0.25, levelCount: 6, maxLeafPoints: 2048 };

const vpFile = JSON.parse(fs.readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8'));
const cameras = vpFile.viewpoints.map((vp) => viewpointToCamera({ ...vp, width: W, height: H }));
const scene = generate({ seed: 1, count: 200000 });
const cloud = scene.cloud;
const hier = buildHierarchy(cloud, HIER);

// 선택에서 점군을 만드는 시험용 헬퍼(materialize 는 select 모듈 소관이라 여기 따로 둔다). 리프 순서대로 이어 붙인다.
function materializeLocal(h, sel) {
  const idx = [], nrm = [], col = [];
  for (let k = 0; k < sel.leafLevel.length; k++) {
    const l = sel.leafLevel[k];
    if (l === NOT_DRAWN) continue;
    const lv = h.levels[l];
    for (let s = lv.leafStart[k]; s < lv.leafStart[k + 1]; s++) {
      idx.push(lv.indices[s]);
      nrm.push(lv.normals[3 * s], lv.normals[3 * s + 1], lv.normals[3 * s + 2]);
      col.push(lv.colors[3 * s], lv.colors[3 * s + 1], lv.colors[3 * s + 2]);
    }
  }
  const m = idx.length;
  const positions = new Float32Array(3 * m);
  idx.forEach((i, k) => positions.set(h.cloud.positions.subarray(3 * i, 3 * i + 3), 3 * k));
  return { format: 1, count: m, positions, normals: Float32Array.from(nrm), colors: Uint8Array.from(col) };
}

// 비교 기준(균일 축소): 모든 보이는 리프를 목표 단계에서 같은 수 U 만큼 올린다(단계 = min(목표+U, 최대)).
// U 는 합이 예산 이하가 되는 가장 작은 값. 예산이 충분하면 U = 0 이라 목표 단계 그대로(selectWithBudget 과 같은 출발점).
// 모두 최대 단계로도 넘으면 selectWithBudget 과 같은 규칙(먼 리프부터, 동률은 번호 큰 쪽부터)으로 뺀다.
function uniformSelect(h, camera, budget) {
  const { visible, distM, target, countAt, levelCount } = leafTargets(h, camera, TAU);
  const L = visible.length;
  const lvl = (k, u) => Math.min(target[k] + u, levelCount - 1);
  const sumAt = (u) => { let s = 0; for (let k = 0; k < L; k++) if (visible[k]) s += countAt(k, lvl(k, u)); return s; };
  let u = 0;
  while (u < levelCount - 1 && sumAt(u) > budget) u++;
  const leafLevel = new Uint8Array(L).fill(NOT_DRAWN);
  for (let k = 0; k < L; k++) if (visible[k]) leafLevel[k] = lvl(k, u);
  let total = sumAt(u);
  const order = [];
  for (let k = 0; k < L; k++) if (visible[k]) order.push(k);
  order.sort((a, b) => distM[b] - distM[a] || b - a);
  for (const k of order) {
    if (total <= budget) break;
    total -= countAt(k, leafLevel[k]);
    leafLevel[k] = NOT_DRAWN;
  }
  return { leafLevel, pointCount: total };
}

function selectionCount(h, sel) {
  let s = 0;
  for (let k = 0; k < sel.leafLevel.length; k++) {
    const l = sel.leafLevel[k];
    if (l !== NOT_DRAWN) s += h.levels[l].leafStart[k + 1] - h.levels[l].leafStart[k];
  }
  return s;
}

const ref = cameras.map((cam) => renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M }).color);
const ssimOf = (cam, i, sel) => ssim(ref[i], renderPoints(cam, materializeLocal(hier, sel), { pointSizeM: POINT_SIZE_M }).color, W, H, 3);

test('모든 예산·시점에서 pointCount ≤ budgetPoints 이고 실제 점 수와 같다', () => {
  for (const b of [...BUDGETS, 0, 1, 100, 5000, 60000]) {
    cameras.forEach((cam) => {
      const sel = selectWithBudget(hier, cam, { budgetPoints: b, thresholdPx: TAU });
      assert.ok(sel.pointCount <= b, `예산 ${b} 초과: ${sel.pointCount}`);
      assert.equal(sel.pointCount, selectionCount(hier, sel));
      assert.equal(sel.leafLevel.length, hier.octree.leafCount);
    });
  }
});

test('예산이 충분하면 목표 단계 그대로, 시야 밖 리프는 NOT_DRAWN', () => {
  cameras.forEach((cam) => {
    const t = leafTargets(hier, cam, TAU);
    const sel = selectWithBudget(hier, cam, { budgetPoints: BUDGETS[0], thresholdPx: TAU });
    assert.deepEqual(Array.from(sel.leafLevel), Array.from(t.target));
    for (let k = 0; k < t.visible.length; k++) if (!t.visible[k]) assert.equal(sel.leafLevel[k], NOT_DRAWN);
  });
});

test('예산을 줄이면 단계는 같거나 거칠어지기만 하고, 빼는 리프는 남는 리프보다 멀다', () => {
  cameras.forEach((cam) => {
    const t = leafTargets(hier, cam, TAU);
    let prev = null;
    for (const b of BUDGETS) {
      const sel = selectWithBudget(hier, cam, { budgetPoints: b, thresholdPx: TAU });
      for (let k = 0; k < sel.leafLevel.length; k++) {
        if (t.visible[k] && sel.leafLevel[k] !== NOT_DRAWN) assert.ok(sel.leafLevel[k] >= t.target[k]);
        if (prev && prev[k] === NOT_DRAWN) assert.equal(sel.leafLevel[k], NOT_DRAWN);
        if (prev && prev[k] !== NOT_DRAWN && sel.leafLevel[k] !== NOT_DRAWN) assert.ok(sel.leafLevel[k] >= prev[k]);
      }
      // 뺀(보이지만 NOT_DRAWN) 리프 중 가장 가까운 것이 남은 리프 중 가장 먼 것보다 가깝지 않다
      let minDropped = Infinity, maxKept = -Infinity;
      for (let k = 0; k < t.visible.length; k++) {
        if (!t.visible[k]) continue;
        if (sel.leafLevel[k] === NOT_DRAWN) minDropped = Math.min(minDropped, t.distM[k]);
        else maxKept = Math.max(maxKept, t.distM[k]);
      }
      assert.ok(minDropped >= maxKept, `가까운 리프를 먼저 뺌: ${minDropped} < ${maxKept}`);
      prev = sel.leafLevel;
    }
  });
});

test('결정적: 같은 입력은 같은 선택', () => {
  const a = selectWithBudget(hier, cameras[0], { budgetPoints: BUDGETS[1], thresholdPx: TAU });
  const b = selectWithBudget(hier, cameras[0], { budgetPoints: BUDGETS[1], thresholdPx: TAU });
  assert.deepEqual(a, b);
});

// 주의(F-096 ③): 150000·600 에서는 선택 = 균일 축소(합 7.7488 = 7.7488, 2.0814 = 2.0814)라 균일 비교로 판별하는 것은 30000 하나뿐이다.
// 판별하는 중간 예산 5개의 시점별 비교와 효율식 반전 변이의 음성 시험은 budget_discrim.test.mjs 에 있다.
test('SSIM: 예산이 클수록 단조 비감소, 같은 예산에서 균일 축소보다 낮지 않음', () => {
  const rows = [];
  for (const b of BUDGETS) {
    let sumSel = 0, sumUni = 0;
    const per = [];
    cameras.forEach((cam, i) => {
      const sel = selectWithBudget(hier, cam, { budgetPoints: b, thresholdPx: TAU });
      const uni = uniformSelect(hier, cam, b);
      assert.ok(sel.pointCount <= b && uni.pointCount <= b);
      const s = ssimOf(cam, i, sel), u = ssimOf(cam, i, uni);
      per.push([s, u]);
      sumSel += s;
      sumUni += u;
    });
    rows.push({ budget: b, sumSel, sumUni, per });
  }
  for (const r of rows) console.log(`budget ${r.budget}: SSIM 합 선택 ${r.sumSel.toFixed(4)}, 균일 ${r.sumUni.toFixed(4)}`);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].sumSel >= rows[i].sumSel, `단조 위반: ${rows[i - 1].budget} → ${rows[i].budget}`);
  for (const r of rows) assert.ok(r.sumSel >= r.sumUni, `예산 ${r.budget}: 균일 축소보다 낮음`);
  // 시점별: 어느 시점도 균일보다 0.01 넘게 낮지 않다(측정: 30000 에서 합 4.6231 대 3.4886).
  for (const r of rows) r.per.forEach(([s, u], i) => assert.ok(s >= u - 0.01, `예산 ${r.budget} 시점 ${i + 1}: 선택 ${s.toFixed(4)} < 균일 ${u.toFixed(4)}`));
});

test('음성: budget 0 은 빈 선택, 음수·NaN·비정수·Infinity 는 lod: 오류', () => {
  const sel = selectWithBudget(hier, cameras[0], { budgetPoints: 0, thresholdPx: TAU });
  assert.equal(sel.pointCount, 0);
  assert.ok(sel.leafLevel.every((l) => l === NOT_DRAWN));
  for (const b of [-1, NaN, 1.5, Infinity, '100', undefined]) {
    assert.throws(() => selectWithBudget(hier, cameras[0], { budgetPoints: b, thresholdPx: TAU }), /^Error: lod:/);
  }
  assert.throws(() => selectWithBudget(hier, cameras[0], { budgetPoints: 10, thresholdPx: 0 }), /^Error: lod:/);
  assert.throws(() => selectWithBudget(hier, cameras[0]), /^Error: lod:/);
});

// F-104 ③: hierarchy 입력 검사. 깨진 입력은 TypeError 가 아니라 'lod:' 오류.
test('hierarchy 입력 검사: null·깨진 계층은 lod: 오류', () => {
  const cam = cameras[0];
  const o = { budgetPoints: 1000, thresholdPx: TAU };
  const bad = [
    null, undefined, 3, {},
    { ...hier, cloud: null },
    { ...hier, octree: null },
    { ...hier, octree: { ...hier.octree, boxMin: null } },
    { ...hier, octree: { ...hier.octree, leafIndex: [] } },
    { ...hier, levels: [] },
    { ...hier, levels: [null] },
    { ...hier, levels: [{ ...hier.levels[0], indices: null }] },
    { ...hier, levels: [{ ...hier.levels[0], leafStart: new Uint32Array(2) }] },
  ];
  for (const b of bad) {
    assert.throws(() => selectWithBudget(b, cam, o), (e) => e instanceof Error && !(e instanceof TypeError) && e.message.startsWith('lod:'), String(b && Object.keys(b)));
    assert.throws(() => leafTargets(b, cam, TAU), (e) => !(e instanceof TypeError) && e.message.startsWith('lod:'));
  }
  assert.doesNotThrow(() => selectWithBudget(hier, cam, o));
});
