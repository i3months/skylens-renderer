// T07.4 화면 공간 오차 기반 단계 선택. 계약: contracts/lod/index.mjs 의 "거리 근거", Selection, LOD_API.select.
//
// selectLevels: 팔진 트리 리프마다
//   0) 점이 하나도 없는 리프(단계 0 구간이 빔)는 그릴 것이 없으므로 NOT_DRAWN(F-104 ④: budget·progressive 와 같은 규칙).
//   1) 리프 상자가 카메라 시야 사각뿔 밖이면(8 꼭짓점이 모두 한 평면의 바깥: 앞(z>0)·좌·우·위·아래; ./view_check.mjs 공용) NOT_DRAWN.
//      opts.pointSizeM(래스터 원판 지름 m)을 주면 좌·우·위·아래 평면을 원판 반경 m = fx·pointSizeM/2 만큼 민 판정
//      (boxMayBeVisibleSplat, 컬링 절두체와 같은 식)을 쓴다(F-126). 없으면 원판 중심 규칙 그대로(기존 결과·시험 값 불변).
//      각 평면은 카메라 좌표에서 선형 반공간이므로 "꼭짓점 전부가 같은 평면 밖" 이면 상자 전체가 밖이다(보수적 판정:
//      여러 평면에 걸쳐 밖인 모서리 상자는 그림으로 남을 수 있으나, 보여야 할 리프를 버리는 일은 없다).
//   2) 아니면 ./screen_error.mjs 의 공용 규칙으로 단계를 고른다(budget·progressive 와 같은 규칙):
//      f = max(fx, fy), d = 상자와 카메라 중심의 최소 거리, cMin = 상자 꼭짓점의 cos(광축 각) 최솟값,
//      d_eff = max(d·cMin², z_P·c_P)(screen_error.mjs 참조) 에 대해 f·edgeM(l)/d_eff ≤ τ 인 가장 큰 l, 최대 단계는 levelCount−1.
//      d = 0 이거나, cMin ≤ 0 이고 P(상자 안 점 집합: 상자 ∩ 시야 사각뿔) 가 비면 단계 0. 걸쳐도 P 가 있으면 d_eff = z_P·c_P.
//      축 밖 각 α 에서 투영 크기는 f·e/(r·cos²α) 이므로(F-097 ①), 리프 상자 안에 놓인 칸 변은 화면에서 τ 픽셀을 넘지 않는다.
// materialize: 선택된 단계의 대표점만 모은다. 위치 = 입력 점 위치 그대로, 법선·색 = 그 단계의 대표값. 새 점을 만들지 않는다.
//   위치는 build 때 리프 순서로 미리 담아 둔 levels[l].positions(입력 위치의 사본)를 법선·색처럼 리프 구간째 복사한다(F-099 ③).
//   이전에는 indices 로 cloud.positions 를 점마다 무작위 접근(gather)했고 이것이 지배 비용이었다. 대가: 대표점당 12 B 메모리.
//
// 칸은 (리프, 전역 격자 칸) 조각이라(F-097 ②, hierarchy) 리프 경계를 걸치는 칸이 없다.
import { NOT_DRAWN, assertCloud } from '../../../contracts/lod/index.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { screenErrorRule } from './screen_error.mjs';
import { lodVisibilityTest } from './view_check.mjs';

export { buildHierarchy } from '../hierarchy/index.mjs';

const ERR = 'lod:';
/** 노드 훑기를 통과한 팔진 트리(약한 참조). 통과 당시의 배열 참조를 함께 기억한다. */
const scanned = new WeakMap();
/** assertCloud 를 통과한 점군(약한 참조) → 통과 당시의 지문(F-121). */
const cloudChecked = new WeakMap();
/** assertHierarchyInput 전체를 통과한 계층(약한 참조) → 통과 당시의 지문(F-121). */
const hierarchyChecked = new WeakMap();
/** 검사 횟수(시험·측정용): full = 실제 검사를 끝까지 돈 횟수, cached = 지문이 같아 건너뛴 횟수. */
const stats = { full: 0, cached: 0 };

/** 검사 캐시 통계의 사본. 시험이 '한 번만 검사' 를 확인하는 데 쓴다. */
export function validationStats() {
  return { full: stats.full, cached: stats.cached };
}

// 지문: 검사가 읽는 모든 참조·스칼라(배열 참조와 길이, count·format·nodeCount·leafCount, 단계 객체 참조)를 평평한 배열로 모은다.
// 배열이나 객체를 바꿔 끼우거나 스칼라가 달라지면 지문이 달라져 다시 검사한다. 배열 "내용" 변조는 잡지 못한다
// (계약: 검증 뒤 계층·점군은 불변; contracts/lod/index.mjs '검증 뒤 불변' 절). 비용은 O(단계 수)로 점 수와 무관하다.
function cloudPrint(c) {
  if (!c || typeof c !== 'object') return null;
  const { positions: p, normals: n, colors: k } = c;
  return [c.format, c.count, p, p?.length, n, n?.length, k, k?.length];
}
function hierarchyPrint(h) {
  const { cloud, octree: o, levels } = h;
  const out = [cloud, ...(cloudPrint(cloud) ?? []), o, o?.leafCount, o?.nodeCount, o?.leafIndex, o?.leafIndex?.length,
    o?.boxMin, o?.boxMin?.length, o?.boxMax, o?.boxMax?.length, levels, levels?.length];
  if (Array.isArray(levels)) {
    for (const lv of levels) {
      out.push(lv, lv?.level, lv?.indices, lv?.indices?.length, lv?.leafStart, lv?.leafStart?.length,
        lv?.positions, lv?.positions?.length, lv?.normals, lv?.normals?.length, lv?.colors, lv?.colors?.length);
    }
  }
  return out;
}
function samePrint(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** assertCloud 의 WeakMap 캐시판(F-121). 같은 점군 객체가 같은 지문으로 이미 통과했으면 O(1)로 건너뛴다. */
export function assertCloudCached(cloud) {
  const fp = cloudPrint(cloud);
  if (fp && samePrint(cloudChecked.get(cloud), fp)) return cloud.count;
  const n = assertCloud(cloud);
  cloudChecked.set(cloud, fp);
  return n;
}

/**
 * 계층 입력 검사(구조·길이·타입). select·budget·progressive 가 공용으로 쓴다(F-107 ①). 오류는 모두 'lod:' 로 시작.
 * nodeCount·leafIndex(=nodeCount)·boxMin/boxMax(=3·nodeCount), 단계별 indices·leafStart·positions·normals·colors.
 */
export function assertHierarchyInput(h) {
  if (!h || typeof h !== 'object') throw new Error(`${ERR} 계층이 객체가 아님`);
  // 계층 전체 캐시(F-121): 같은 계층 객체가 같은 지문으로 이미 통과했으면 점 수와 무관하게 O(단계 수)로 끝낸다.
  // 그래서 cullAndSelect 가 앞에서 한 번, selectLevels 가 안에서 또 한 번 불러도 실제 검사는 계층마다 한 번이다.
  const fp = hierarchyPrint(h);
  if (samePrint(hierarchyChecked.get(h), fp)) { stats.cached++; return; }
  validateHierarchy(h);
  stats.full++;
  hierarchyChecked.set(h, fp);
}

function validateHierarchy(h) {
  const { octree, levels } = h;
  assertCloudCached(h.cloud);
  if (!octree || typeof octree !== 'object' || !Number.isInteger(octree.leafCount) || octree.leafCount < 1) throw new Error(`${ERR} 계층의 팔진 트리가 올바르지 않음`);
  const nc = octree.nodeCount;
  if (!Number.isInteger(nc) || nc < octree.leafCount) throw new Error(`${ERR} octree.nodeCount 는 leafCount 이상의 정수: ${String(nc)}`);
  if (!(octree.boxMin instanceof Float32Array) || !(octree.boxMax instanceof Float32Array) || !(octree.leafIndex instanceof Int32Array)) throw new Error(`${ERR} 팔진 트리 상자·리프 번호 배열이 없음`);
  if (octree.leafIndex.length !== nc) throw new Error(`${ERR} octree.leafIndex 길이(${octree.leafIndex.length}) 가 nodeCount(${nc}) 와 다름`);
  if (octree.boxMin.length !== 3 * nc || octree.boxMax.length !== 3 * nc) throw new Error(`${ERR} octree.boxMin/boxMax 길이가 3·nodeCount(${3 * nc}) 가 아님`);
  if (!Array.isArray(levels) || levels.length < 1) throw new Error(`${ERR} 계층의 단계 배열이 비었음`);
  for (const lv of levels) {
    if (!lv || !(lv.indices instanceof Uint32Array) || !(lv.leafStart instanceof Uint32Array) || lv.leafStart.length !== octree.leafCount + 1) {
      throw new Error(`${ERR} 단계 ${String(lv?.level)} 의 구간 배열이 올바르지 않음`);
    }
    const n = lv.indices.length;
    if (!(lv.positions instanceof Float32Array) || lv.positions.length !== 3 * n) throw new Error(`${ERR} 단계 ${String(lv.level)} 의 positions 가 Float32Array(3·n) 가 아님`);
    if (!(lv.normals instanceof Float32Array) || lv.normals.length !== 3 * n) throw new Error(`${ERR} 단계 ${String(lv.level)} 의 normals 가 Float32Array(3·n) 가 아님`);
    if (!(lv.colors instanceof Uint8Array) || lv.colors.length !== 3 * n) throw new Error(`${ERR} 단계 ${String(lv.level)} 의 colors 가 Uint8Array(3·n) 가 아님`);
    // leafStart: 0 에서 시작해 n 으로 끝나는 비감소 열(리프 k 의 구간 = [leafStart[k], leafStart[k+1])).
    const ls = lv.leafStart;
    if (ls[0] !== 0 || ls[octree.leafCount] !== n) throw new Error(`${ERR} 단계 ${String(lv.level)} 의 leafStart 는 0 에서 시작해 ${n} 으로 끝나야 함`);
    for (let k = 0; k < octree.leafCount; k++) {
      if (ls[k] > ls[k + 1]) throw new Error(`${ERR} 단계 ${String(lv.level)} 의 leafStart 가 감소함 (k=${k})`);
    }
  }
  // 노드 한 번 훑기(O(노드)): 같은 팔진 트리 객체가 이미 통과했으면 건너뛴다(F-112 ③).
  // 계약: 검증 통과 뒤 같은 객체의 배열 "내용" 을 바꾸면(예: leafIndex[3] = -2) 이 캐시는 못 잡는다.
  // 배열 자체를 바꿔 끼우거나 길이·타입·nodeCount 가 달라진 경우는 위의 O(1) 검사와 아래 참조 비교로 매번 잡힌다.
  // 변조 가능성을 없애려면 계층을 불변으로 다루거나 새 객체로 복사해서 넘길 것.
  const { leafIndex, boxMin, boxMax, leafCount } = octree;
  const done = scanned.get(octree);
  if (done && done.leafIndex === leafIndex && done.boxMin === boxMin && done.boxMax === boxMax && done.nc === nc && done.leafCount === leafCount) return;
  // leafIndex: 내부 노드는 -1, 리프는 0..leafCount-1 을 정확히 한 번씩(중복·누락 없음; F-112 ①).
  const seen = new Uint8Array(leafCount);
  let leaves = 0;
  for (let i = 0; i < nc; i++) {
    const v = leafIndex[i];
    if (v !== -1) {
      if (!(v >= 0 && v < leafCount)) throw new Error(`${ERR} octree.leafIndex[${i}] = ${v} 가 -1 또는 0..${leafCount - 1} 범위 밖`);
      if (seen[v]) throw new Error(`${ERR} octree.leafIndex[${i}] = ${v} 리프 번호가 중복됨`);
      seen[v] = 1;
      leaves++;
    }
    // 상자: 값이 NaN 이 아니고 boxMin ≤ boxMax. buildOctree 는 Float32 최댓값으로 잘라 유한하게 만든다.
    for (let a = 3 * i; a < 3 * i + 3; a++) {
      const lo = boxMin[a], hi = boxMax[a];
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`${ERR} 노드 ${i} 의 상자에 유한하지 않은 값이 있음`);
      if (lo > hi) throw new Error(`${ERR} 노드 ${i} 의 boxMin 이 boxMax 보다 큼`);
    }
  }
  if (leaves !== leafCount) throw new Error(`${ERR} octree.leafIndex 의 리프 수(${leaves}) 가 leafCount(${leafCount}) 와 다름(누락)`);
  scanned.set(octree, { leafIndex, boxMin, boxMax, nc, leafCount });
}

/** 카메라 검사 오류를 'lod:' 오류로 옮긴다. */
function checkCamera(camera) {
  try {
    assertCamera(camera);
  } catch (e) {
    throw new Error(`${ERR} 카메라가 올바르지 않음 (${e.message})`);
  }
}

/**
 * 리프마다 단계를 고른다.
 * @param {import('../../../contracts/lod/index.mjs').Hierarchy} hierarchy
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {{thresholdPx:number, pointSizeM?:number}} opts thresholdPx = 허용 화면 오차 τ(px),
 *   pointSizeM = 래스터 원판 지름(m, 선택). 주면 시야 판정이 원판 반경 여유를 둔다(F-126); 없으면 원판 중심 규칙.
 * @returns {import('../../../contracts/lod/index.mjs').Selection}
 */
export function selectLevels(hierarchy, camera, opts) {
  assertHierarchyInput(hierarchy);
  checkCamera(camera);
  const thresholdPx = opts?.thresholdPx;
  if (!(typeof thresholdPx === 'number' && Number.isFinite(thresholdPx) && thresholdPx > 0)) throw new Error(`${ERR} thresholdPx 는 양의 유한수: ${String(thresholdPx)}`);
  const mayBeVisible = lodVisibilityTest(opts.pointSizeM);
  const { octree, levels, edge0M } = hierarchy;
  const rule = screenErrorRule(camera, { thresholdPx, edge0M, levelCount: levels.length });
  const leafLevel = new Uint8Array(octree.leafCount).fill(NOT_DRAWN);
  let pointCount = 0;
  const mn = [0, 0, 0], mx = [0, 0, 0];
  for (let node = 0; node < octree.nodeCount; node++) {
    const k = octree.leafIndex[node];
    if (k < 0) continue;
    if (levels[0].leafStart[k + 1] === levels[0].leafStart[k]) continue; // 빈 리프는 NOT_DRAWN
    for (let a = 0; a < 3; a++) { mn[a] = octree.boxMin[3 * node + a]; mx[a] = octree.boxMax[3 * node + a]; }
    if (!mayBeVisible(camera, mn, mx)) continue;
    const l = rule.leaf(mn, mx).level;
    leafLevel[k] = l;
    pointCount += levels[l].leafStart[k + 1] - levels[l].leafStart[k];
  }
  return { leafLevel, pointCount };
}

/**
 * 선택된 단계의 대표점으로 점군을 만든다(format 1, count = selection.pointCount). 새 점 없음.
 * @returns {import('../../../contracts/lod/index.mjs').Point27Cloud}
 */
export function materialize(hierarchy, selection) {
  assertHierarchyInput(hierarchy);
  const { octree, levels } = hierarchy;
  if (!selection || !(selection.leafLevel instanceof Uint8Array) || selection.leafLevel.length !== octree.leafCount) {
    throw new Error(`${ERR} selection.leafLevel 은 길이 leafCount(${octree.leafCount}) 인 Uint8Array`);
  }
  const { leafLevel } = selection;
  let n = 0;
  for (let k = 0; k < octree.leafCount; k++) {
    const l = leafLevel[k];
    if (l === NOT_DRAWN) continue;
    if (l >= levels.length) throw new Error(`${ERR} 리프 ${k} 의 단계 ${l} 가 단계 수 ${levels.length} 를 넘음`);
    n += levels[l].leafStart[k + 1] - levels[l].leafStart[k];
  }
  if (selection.pointCount !== n) throw new Error(`${ERR} selection.pointCount(${String(selection.pointCount)}) 와 실제 점 수(${n}) 불일치`);
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  let o = 0;
  for (let k = 0; k < octree.leafCount; k++) {
    const l = leafLevel[k];
    if (l === NOT_DRAWN) continue;
    const lv = levels[l];
    const s0 = lv.leafStart[k], s1 = lv.leafStart[k + 1];
    if (s1 === s0) continue;
    // 위치·법선·색 모두 리프 구간이 연속이라 한 번에 복사한다.
    positions.set(lv.positions.subarray(3 * s0, 3 * s1), 3 * o);
    normals.set(lv.normals.subarray(3 * s0, 3 * s1), 3 * o);
    colors.set(lv.colors.subarray(3 * s0, 3 * s1), 3 * o);
    o += s1 - s0;
  }
  return { format: 1, count: n, positions, normals, colors };
}
