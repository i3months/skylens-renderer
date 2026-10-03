// T07.5 점 예산 상한 하의 단계 선택. 계약: contracts/lod/index.mjs 의 LOD_API.budget, Selection, NOT_DRAWN.
//
// selectWithBudget(hierarchy, camera, {budgetPoints, thresholdPx}) -> Selection,  pointCount ≤ budgetPoints 를 항상 지킨다.
//
// server/lod/select(selectLevels) 와 독립이다: 리프별 거리·목표 단계를 이 모듈 안에서 직접 계산하고,
// 거리 → 단계 규칙은 server/lod/distance_table 의 buildDistanceTable/levelForDistance 를 그대로 쓴다.
//
// 절차
//  1) 시야 판정: 리프 상자 8 꼭짓점을 카메라 좌표로 옮겨, 한 절두체 평면(근평면 z>0, 화면 좌·우·위·아래)의
//     바깥에 8 점이 모두 있으면 시야 밖 → NOT_DRAWN. 상자는 볼록이므로 이 판정은 보수적이다(보이는 리프를 버리지 않음).
//     점이 하나도 없는 리프도 그릴 것이 없으므로 NOT_DRAWN.
//  2) 거리 d: 카메라 중심에서 리프 상자까지의 최단 거리(상자 안이면 0). 가장 가까운 점이 가장 큰 화면 오차를 내므로
//     보수적(더 고운 단계)이다. d 가 0 에 가까우면 levelForDistance 가 양수만 받으므로 MIN_DIST_M 으로 아래를 막는다.
//  3) 목표 단계 = levelForDistance(표, d). 표는 fx = camera.K.fx, τ = thresholdPx, edge0M·levelCount 는 계층 값.
//     합이 예산 이하면 그대로 돌려준다.
//  4) 예산 초과면 탐욕적 거칠게 하기: 리프 k 를 단계 l → l' (> l) 로 올리면
//       절감 ΔN = count_k(l) − count_k(l'),  화면 오차 증가 ΔE = fx·(edgeM(l') − edgeM(l))/d_k  (px)
//     효율 = ΔN/ΔE 가 가장 큰 (리프, l') 부터 적용한다(최대 힙). 한 리프의 후보는 l' = l+1..최대 단계 중 효율 최대인 것
//     (단계별 점 수가 단조가 아닐 수 있어 한 단계만 보면 막힐 수 있으므로 앞을 모두 본다). ΔN ≤ 0 인 후보는 쓰지 않는다.
//     적용 후 그 리프의 새 후보를 다시 넣는다. 합이 예산 이하가 되는 순간 멈춘다.
//     동률은 리프 번호가 작은 쪽이 먼저(결정적). 과정이 예산과 무관한 같은 순서를 따르므로
//     예산이 크면 같은 순서의 앞에서 멈출 뿐이다(예산이 클수록 모든 리프의 단계가 같거나 더 곱다).
//  5) 더 줄일 후보가 없는데도(모든 보이는 리프가 더 줄 수 없는 단계) 예산 초과면 리프를 통째로 NOT_DRAWN 으로 뺀다.
//     규칙(결정): 거리 d 가 가장 먼 리프부터 뺀다. 같은 점 간격이라면 먼 리프일수록 화면에서 차지하는 크기가 1/d 로
//     작아 화면 기여가 작기 때문이다. 가까운 쪽(화면을 크게 차지하는 곳)을 먼저 비우지 않는다.
//     동률(같은 d)은 리프 번호가 큰 쪽부터 뺀다(결정적). 합이 예산 이하가 되면 멈춘다.
//
// 입력 검사(음성 규칙, 결정)
//  - budgetPoints = 0: 올바른 입력으로 보고 빈 선택(모든 리프 NOT_DRAWN, pointCount 0)을 돌려준다.
//    "점을 하나도 그리지 말라" 는 뜻이 분명하고 pointCount ≤ 0 을 만족하는 유일한 답이기 때문이다.
//  - 음수, NaN, ±Infinity, 정수가 아닌 수, 수가 아닌 값: 'lod:' 로 시작하는 Error. 의미가 없는 예산을 조용히 0 으로
//    바꾸면 호출 쪽 버그를 숨기므로 던진다.
//  - thresholdPx 는 distance_table 의 검사(양의 유한수, 'lod:' 오류)를 그대로 따른다. 카메라는 raster 계약 검사('raster:').

import { NOT_DRAWN, edgeOfLevel } from '../../../contracts/lod/index.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { buildDistanceTable, levelForDistance } from '../distance_table/index.mjs';

const ERR = 'lod:';
// 거리 하한(m). 카메라가 리프 상자 안·위에 있으면 d = 0 이 되는데 levelForDistance 는 양수만 받는다.
// 1 mm 는 어떤 τ·fx 에서도 단계 0 을 고르게 할 만큼 작다(가장 고운 단계로 처리하는 것이 보수적).
const MIN_DIST_M = 1e-3;

function assertHierarchy(h) {
  if (!h || typeof h !== 'object') throw new Error(`${ERR} 계층이 객체가 아님`);
  const { octree, levels } = h;
  if (!octree || !Number.isInteger(octree.leafCount) || !Number.isInteger(octree.nodeCount)) throw new Error(`${ERR} hierarchy.octree 가 계약대로가 아님`);
  if (!Array.isArray(levels) || levels.length < 1) throw new Error(`${ERR} hierarchy.levels 가 비어 있음`);
  for (const lv of levels) {
    if (!(lv.leafStart instanceof Uint32Array) || lv.leafStart.length !== octree.leafCount + 1) throw new Error(`${ERR} levels[${lv.level}].leafStart 길이가 leafCount+1 이 아님`);
  }
}

function assertBudget(b) {
  if (typeof b !== 'number' || !Number.isInteger(b) || b < 0) {
    throw new Error(`${ERR} budgetPoints 는 0 이상의 정수: ${String(b)}`);
  }
}

/** 리프 번호 → 노드 번호. */
function leafNodes(octree) {
  const out = new Int32Array(octree.leafCount).fill(-1);
  for (let n = 0; n < octree.nodeCount; n++) {
    const k = octree.leafIndex[n];
    if (k >= 0) out[k] = n;
  }
  return out;
}

/** 상자(월드)가 시야 절두체와 겹칠 수 있으면 true(보수적). */
function boxVisible(camera, mn, mx) {
  const { R, t, K, width, height } = camera;
  // 평면별로 "모든 꼭짓점이 바깥" 인지 센다. 바깥 조건(카메라 좌표 x,y,z):
  //   근평면 z ≤ 0, 왼쪽 u<0 ⇔ fx·x + cx·z < 0, 오른쪽 u>W ⇔ fx·x + (cx−W)·z > 0, 위·아래도 같은 식(fy, cy, H).
  let near = 0, left = 0, right = 0, top = 0, bottom = 0;
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? mx[0] : mn[0];
    const y = c & 2 ? mx[1] : mn[1];
    const z = c & 4 ? mx[2] : mn[2];
    const xc = R[0] * x + R[1] * y + R[2] * z + t[0];
    const yc = R[3] * x + R[4] * y + R[5] * z + t[1];
    const zc = R[6] * x + R[7] * y + R[8] * z + t[2];
    if (zc <= 0) near++;
    if (K.fx * xc + K.cx * zc < 0) left++;
    if (K.fx * xc + (K.cx - width) * zc > 0) right++;
    if (K.fy * yc + K.cy * zc < 0) top++;
    if (K.fy * yc + (K.cy - height) * zc > 0) bottom++;
  }
  return !(near === 8 || left === 8 || right === 8 || top === 8 || bottom === 8);
}

/** 점 p 에서 상자까지 최단 거리(안이면 0). */
function distToBox(p, mn, mx) {
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const v = p[a] < mn[a] ? mn[a] - p[a] : p[a] > mx[a] ? p[a] - mx[a] : 0;
    s += v * v;
  }
  return Math.sqrt(s);
}

// 최대 힙: 효율 내림차순, 동률이면 리프 번호 오름차순.
const better = (a, b) => a.eff > b.eff || (a.eff === b.eff && a.leaf < b.leaf);
function heapPush(h, e) {
  h.push(e);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!better(h[i], h[p])) break;
    [h[i], h[p]] = [h[p], h[i]];
    i = p;
  }
}
function heapPop(h) {
  const top = h[0];
  const last = h.pop();
  if (h.length > 0) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && better(h[l], h[m])) m = l;
      if (r < h.length && better(h[r], h[m])) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }
  return top;
}

/**
 * 리프별 시야·거리·목표 단계를 계산한다(예산과 무관). 시험과 비교 기준이 같은 값을 쓰도록 내보낸다.
 * @returns {{visible: Uint8Array, distM: Float64Array, target: Uint8Array, countAt: (leaf:number, level:number)=>number, levelCount: number}}
 */
export function leafTargets(hierarchy, camera, thresholdPx) {
  assertHierarchy(hierarchy);
  assertCamera(camera);
  const { octree, levels, edge0M } = hierarchy;
  const levelCount = levels.length;
  const table = buildDistanceTable({ fx: camera.K.fx, thresholdPx, edge0M, levelCount });
  // 카메라 중심 C = −Rᵀ·t
  const { R, t } = camera;
  const C = [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
  const nodes = leafNodes(octree);
  const L = octree.leafCount;
  const visible = new Uint8Array(L);
  const distM = new Float64Array(L);
  const target = new Uint8Array(L).fill(NOT_DRAWN);
  const countAt = (k, l) => levels[l].leafStart[k + 1] - levels[l].leafStart[k];
  for (let k = 0; k < L; k++) {
    const n = nodes[k];
    if (n < 0) continue;
    const mn = octree.boxMin.subarray(3 * n, 3 * n + 3);
    const mx = octree.boxMax.subarray(3 * n, 3 * n + 3);
    distM[k] = distToBox(C, mn, mx);
    if (countAt(k, 0) === 0 || !boxVisible(camera, mn, mx)) continue;
    visible[k] = 1;
    target[k] = levelForDistance(table, Math.max(distM[k], MIN_DIST_M));
  }
  return { visible, distM, target, countAt, levelCount };
}

/** 리프 k 를 단계 l 에서 더 거칠게 할 가장 효율 좋은 후보. 없으면 null. */
function bestStep(k, l, d, ctx) {
  const { countAt, levelCount, edge0M, fx } = ctx;
  const n0 = countAt(k, l);
  const e0 = edgeOfLevel(edge0M, l);
  let best = null;
  for (let m = l + 1; m < levelCount; m++) {
    const saved = n0 - countAt(k, m);
    if (saved <= 0) continue;
    const dErr = (fx * (edgeOfLevel(edge0M, m) - e0)) / d; // 화면 오차 증가(px), 항상 양수
    const eff = saved / dErr;
    if (best === null || eff > best.eff) best = { eff, leaf: k, to: m, saved };
  }
  return best;
}

/**
 * 점 예산 상한 하에서 리프별 단계를 고른다. 머리 주석의 절차·음성 규칙 참조.
 * @param {import('../../../contracts/lod/index.mjs').Hierarchy} hierarchy
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {{budgetPoints:number, thresholdPx:number}} opts
 * @returns {import('../../../contracts/lod/index.mjs').Selection}
 */
export function selectWithBudget(hierarchy, camera, opts) {
  if (!opts || typeof opts !== 'object') throw new Error(`${ERR} 옵션이 객체가 아님`);
  const { budgetPoints, thresholdPx } = opts;
  assertBudget(budgetPoints);
  const { visible, distM, target, countAt, levelCount } = leafTargets(hierarchy, camera, thresholdPx);
  const L = target.length;
  const leafLevel = Uint8Array.from(target);
  let total = 0;
  for (let k = 0; k < L; k++) if (visible[k]) total += countAt(k, leafLevel[k]);
  if (total <= budgetPoints) return { leafLevel, pointCount: total };

  // 4) 탐욕적 거칠게 하기
  const ctx = { countAt, levelCount, edge0M: hierarchy.edge0M, fx: camera.K.fx };
  const dOf = (k) => Math.max(distM[k], MIN_DIST_M);
  const heap = [];
  for (let k = 0; k < L; k++) {
    if (!visible[k]) continue;
    const s = bestStep(k, leafLevel[k], dOf(k), ctx);
    if (s) heapPush(heap, s);
  }
  while (total > budgetPoints && heap.length > 0) {
    const s = heapPop(heap);
    leafLevel[s.leaf] = s.to;
    total -= s.saved;
    const nxt = bestStep(s.leaf, s.to, dOf(s.leaf), ctx);
    if (nxt) heapPush(heap, nxt);
  }
  if (total <= budgetPoints) return { leafLevel, pointCount: total };

  // 5) 먼 리프부터 통째로 뺀다(같은 거리면 번호 큰 쪽부터)
  const drawn = [];
  for (let k = 0; k < L; k++) if (leafLevel[k] !== NOT_DRAWN) drawn.push(k);
  drawn.sort((a, b) => distM[b] - distM[a] || b - a);
  for (const k of drawn) {
    if (total <= budgetPoints) break;
    total -= countAt(k, leafLevel[k]);
    leafLevel[k] = NOT_DRAWN;
  }
  return { leafLevel, pointCount: total };
}
