// F-096 ③: 예산 선택이 균일 축소보다 나은 "판별하는" 중간 예산 여러 개를 시점별로 비교하고,
// 효율식을 뒤집은 가짜 변이가 그 예산들에서 실패하는지 본다(변이는 이 파일 안의 사본이며 index.mjs 는 건드리지 않는다).
//
// budget.test.mjs 는 150000·600 에서 선택 = 균일 축소(둘 다 7.3269 / 2.0824)라 판별은 30000 하나뿐이었다.
// 아래 예산은 선택 ≠ 균일 인 값만 골랐다. 값 근거(측정, 2026-10-03): 같은 장면·계층·시점·렌더 조건(아래 상수)에서
// 8시점 SSIM 을 재서 얻은 표. 각 항목 = 합(선택 / 균일 / 효율 반전 변이).
//   시드 1·2·3 각각 합 선택 / 합 균일 / 이긴 시점 수(차 > WIN 0.01, 8시점 중), 합 변이(효율 반전)는 시드 1 / 2 / 3.
//   예산     시드 1             시드 2             시드 3             합 변이(1 / 2 / 3)
//   100000   7.2994/6.1955  8   7.3209/6.3343  7   7.3292/6.1746  8   5.1123 / 5.1463 / 5.3308
//    80000   6.7907/6.1955  7   6.8213/5.7968  7   6.8750/6.1746  8   4.0085 / 4.0401 / 4.3547
//    45000   5.3268/3.6647  8   5.4404/3.6664  8   5.4561/3.7676  8   2.9712 / 2.8816 / 3.3527
//    20000   3.8137/2.5582  7   3.8073/2.5144  6   4.1156/2.8022  7   2.4738 / 2.4408 / 2.8287
//    10000   2.9183/2.4581  5   2.9083/2.3616  5   3.1736/2.7106  6   2.3209 / 2.1691 / 2.6342
//   (측정일 2026-10-03: 현재 HEAD 에서 재측정. 변이는 시점별·이긴 시점 수·합 차 조건을 함께 어긴다.)
// 예산 값은 budget/index.mjs 가 수정 중이어도 판별이 유지되도록 서로 멀리 떨어뜨렸다. 단언 한계는 아래 DISCRIM 주석의 사전 규칙
// (시드 최솟값의 절반)으로 잡았다. 시점별로는 균일보다 SLACK 넘게 낮지 않아야 한다(80000 시점 2 의 −0.0119 같은 경우가 실제로 있다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectWithBudget, leafTargets } from './index.mjs';
import { edgeOfLevel } from '../../../contracts/lod/index.mjs';
import { buildHierarchy } from '../hierarchy/index.mjs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { ssim } from '../../metrics/ssim/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';

const W = 320, H = 180;
const TAU = 1;
const POINT_SIZE_M = 0.6;
const HIER = { edge0M: 0.25, levelCount: 6, maxLeafPoints: 2048 };

const vpFile = JSON.parse(fs.readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8'));
const cameras = vpFile.viewpoints.map((vp) => viewpointToCamera({ ...vp, width: W, height: H }));
// 장면 시드(F-102 ⑥): 한 시드에 맞춘 한계가 되지 않도록 세 시드 모두에서 같은 한계로 시험한다.
// DISCRIM_SEEDS="1,2" 처럼 환경변수로 줄여 돌릴 수 있다(기본 1,2,3).
const SEEDS = (process.env.DISCRIM_SEEDS ?? '1,2,3').split(',').map(Number);

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
  const { visible, distM, effDistM, target, countAt, levelCount, focalPx } = leafTargets(h, camera, TAU);
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


// 효율식 변이 사본: selectWithBudget 의 4)단계(탐욕적 거칠게 하기)·5)단계를 그대로 옮기되 invert 면 효율 부호를 뒤집는다.
// invert=false 사본이 selectWithBudget 과 같은 선택을 내는지 아래 시험이 확인해 변이가 충실함을 보인다.
function greedySelect(h, camera, budget, invert) {
  const { visible, distM, effDistM, target, countAt, levelCount, focalPx } = leafTargets(h, camera, TAU);
  const L = target.length;
  const leafLevel = Uint8Array.from(target);
  let total = 0;
  for (let k = 0; k < L; k++) if (visible[k]) total += countAt(k, leafLevel[k]);
  if (total <= budget) return { leafLevel, pointCount: total };
  const fx = focalPx; // F-097 ①: f = max(fx, fy), 실효 거리 d_eff = d·cMin²
  const e = (l) => edgeOfLevel(h.edge0M, l);
  const best = (k, l) => {
    let b = null;
    const d = Math.max(effDistM[k], 1e-3);
    for (let m = l + 1; m < levelCount; m++) {
      const saved = countAt(k, l) - countAt(k, m);
      if (saved <= 0) continue;
      let eff = saved / ((fx * (e(m) - e(l))) / d);
      if (invert) eff = -eff;
      if (b === null || eff > b.eff) b = { eff, leaf: k, to: m, saved };
    }
    return b;
  };
  const cand = [];
  for (let k = 0; k < L; k++) if (visible[k]) { const s = best(k, leafLevel[k]); if (s) cand.push(s); }
  while (total > budget && cand.length > 0) {
    let bi = 0;
    for (let i = 1; i < cand.length; i++) {
      const a = cand[i], b = cand[bi];
      if (a.eff > b.eff || (a.eff === b.eff && a.leaf < b.leaf)) bi = i;
    }
    const s = cand.splice(bi, 1)[0];
    leafLevel[s.leaf] = s.to;
    total -= s.saved;
    const n = best(s.leaf, s.to);
    if (n) cand.push(n);
  }
  if (total > budget) {
    const drawn = [];
    for (let k = 0; k < L; k++) if (leafLevel[k] !== NOT_DRAWN) drawn.push(k);
    drawn.sort((a, b) => distM[b] - distM[a] || b - a);
    for (const k of drawn) {
      if (total <= budget) break;
      total -= countAt(k, leafLevel[k]);
      leafLevel[k] = NOT_DRAWN;
    }
  }
  return { leafLevel, pointCount: total };
}

// 현재 시드의 계층·원본 렌더(시험이 시드를 차례로 바꾼다).
let hier, ref, curSeed;
function useSeed(seed) {
  if (curSeed === seed) return;
  const cloud = generate({ seed, count: 200000 }).cloud;
  hier = buildHierarchy(cloud, HIER);
  ref = cameras.map((cam) => renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M }).color);
  curSeed = seed;
}
const ssimOf = (cam, i, sel) => ssim(ref[i], renderPoints(cam, materializeLocal(hier, sel), { pointSizeM: POINT_SIZE_M }).color, W, H, 3);

// 예산별 한계. minGap = 합 선택 − 합 균일 의 하한, minWins = 균일보다 WIN 넘게 나은 시점 수의 하한.
// 근거(F-102 ⑥, 사전 규칙): 시드 1·2·3 의 측정 최솟값(머리 표)의 절반. minGap 은 소수 둘째 자리 내림, minWins 는 내림.
// 측정 뒤에 통과하도록 낮춘 값이 아니다. 예: 20000 의 합 차 최솟값 1.2328 → 0.61, 이긴 시점 최솟값 6 → 3.
// SLACK 은 최댓값형 한계(시점별로 균일보다 낮아도 되는 폭)라 절반 규칙을 쓸 수 없다. 측정한 최악 부족분 −0.0119
// (시드 2, 예산 80000, 시점 2)의 약 2배로 잡았다(0.0119 → 0.025). 이전 0.01 은 시드 1 의 −0.008 에 맞춘 값이었다.
const DISCRIM = [
  { budget: 100000, minGap: 0.49, minWins: 3 },
  { budget: 80000, minGap: 0.29, minWins: 3 },
  { budget: 45000, minGap: 0.83, minWins: 4 },
  { budget: 20000, minGap: 0.62, minWins: 3 },
  { budget: 10000, minGap: 0.23, minWins: 2 },
];
const WIN = 0.01; // 이긴 시점의 기준: 선택 − 균일 > WIN
const SLACK = 0.025;


const measure = (budget, pick) => {
  const per = cameras.map((cam, i) => ({ sel: ssimOf(cam, i, pick(cam)), uni: ssimOf(cam, i, uniformSelect(hier, cam, budget)) }));
  return { per, sumSel: per.reduce((a, r) => a + r.sel, 0), sumUni: per.reduce((a, r) => a + r.uni, 0) };
};
// 판별 조건: 시점마다 균일보다 SLACK 넘게 낮지 않고, 이기는 시점 수 ≥ minWins, 합의 차 ≥ minGap. 어기면 사유 목록을 돌려준다.
const violations = (m, { budget, minGap, minWins }) => {
  const v = [];
  m.per.forEach((r, i) => { if (r.sel < r.uni - SLACK) v.push(`예산 ${budget} 시점 ${i + 1}: 선택 ${r.sel.toFixed(4)} < 균일 ${r.uni.toFixed(4)}`); });
  const wins = m.per.filter((r) => r.sel - r.uni > WIN).length;
  if (wins < minWins) v.push(`예산 ${budget}: 이기는 시점 ${wins} < ${minWins}`);
  if (m.sumSel - m.sumUni < minGap) v.push(`예산 ${budget}: 합 차 ${(m.sumSel - m.sumUni).toFixed(4)} < ${minGap}`);
  return v;
};

const real = new Map();
const realOf = (c) => { const key = `${curSeed}/${c.budget}`; if (!real.has(key)) real.set(key, measure(c.budget, (cam) => selectWithBudget(hier, cam, { budgetPoints: c.budget, thresholdPx: TAU }))); return real.get(key); };
const winsOf = (m) => m.per.filter((r) => r.sel - r.uni > WIN).length;

test('판별 예산에서 선택 ≠ 균일이고, 시점별로 균일보다 낮지 않으며 합 차가 한계 이상', () => {
  for (const seed of SEEDS) for (const c of DISCRIM) {
    useSeed(seed);
    cameras.forEach((cam) => {
      const sel = selectWithBudget(hier, cam, { budgetPoints: c.budget, thresholdPx: TAU });
      assert.ok(sel.pointCount <= c.budget);
    });
    const m = realOf(c);
    console.log(`시드 ${seed} budget ${c.budget}: 합 선택 ${m.sumSel.toFixed(4)}, 균일 ${m.sumUni.toFixed(4)}, 차 ${(m.sumSel - m.sumUni).toFixed(4)}, 이김 ${winsOf(m)}, 최악 시점 차 ${Math.min(...m.per.map((r) => r.sel - r.uni)).toFixed(4)}; 시점별 ${m.per.map((r) => `${r.sel.toFixed(3)}/${r.uni.toFixed(3)}`).join(' ')}`);
    assert.deepEqual(violations(m, c), []);
  }
});

test('변이 사본(효율 그대로)은 selectWithBudget 과 같은 선택 — 변이가 충실함', () => {
  for (const seed of SEEDS) for (const c of DISCRIM) {
    useSeed(seed);
    cameras.forEach((cam) => {
      const a = selectWithBudget(hier, cam, { budgetPoints: c.budget, thresholdPx: TAU });
      const b = greedySelect(hier, cam, c.budget, false);
      assert.deepEqual(Array.from(b.leafLevel), Array.from(a.leafLevel));
      assert.equal(b.pointCount, a.pointCount);
    });
  }
});

test('음성: 효율식 반전 변이는 판별 예산 둘 이상에서 위 조건을 어긴다', () => {
  for (const seed of SEEDS) {
    useSeed(seed);
    let failed = 0;
    for (const c of DISCRIM) {
      const m = measure(c.budget, (cam) => greedySelect(hier, cam, c.budget, true));
      const v = violations(m, c);
      console.log(`시드 ${seed} 변이 budget ${c.budget}: 합 ${m.sumSel.toFixed(4)} (균일 ${m.sumUni.toFixed(4)}), 위반 ${v.length}`);
      if (v.length > 0) failed++;
    }
    assert.ok(failed >= 2, `시드 ${seed}: 변이가 실패한 예산 수 ${failed}`);
    assert.equal(failed, DISCRIM.length, `시드 ${seed}: 변이가 모든 판별 예산에서 실패해야 함`);
  }
});
