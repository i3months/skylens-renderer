// T07.9 점진 순서(거친 단계 먼저). 계약: contracts/lod/index.mjs 의 LOD_API.progressive.
// selectLevels 결과에 의존하지 않는다: 리프의 목표 단계는 이 모듈 안에서 계산하되, 화면 오차 규칙
// (f = max(fx,fy), d_eff = max(d·cMin², z_P·c_P), 거리표; screen_error.mjs 참조)은 server/lod/select/screen_error.mjs 의 공용 함수를 그대로 쓴다.
//
// 델레이 패턴(RULES §1.1): 같은 구간(리프)의 낮은 단계는 높은 단계로 "교체"한다(누적 아님),
//   이미 추월당한 중간 단계는 건너뛴다. 그래서 한 리프의 조각은 최대 2개다.
//     목표 T == 최대 단계  -> [최대 단계 조각]
//     목표 T <  최대 단계  -> [최대 단계 조각, T 단계 조각]   (사이 단계는 보내지 않음)
// 조각 순서: 거친 단계(큰 level) 먼저, 같은 단계 안에서는 카메라에 가까운 리프 먼저(동률이면 리프 번호).
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { screenErrorRule } from '../select/screen_error.mjs';
import { boxMayBeVisible } from '../select/view_check.mjs';
import { assertHierarchyInput } from '../budget/index.mjs';

const ERR = 'lod:';

// 참고(F-107 ⑨): selectLevels 를 처음 부를 때 드는 약 +11 ms 의 준비 비용은 리프가 수만 개가 되기 전에는
//   미리 줄일 필요가 없다. 그 규모 전에는 최적화하지 않는다(여기 progressiveChunks 의 leafNodes 도 같은 이유로 호출마다 만든다).

/** 리프 번호 -> 노드 번호(octree.leafIndex 의 역) */
function leafNodes(octree) {
  const m = new Int32Array(octree.leafCount);
  for (let n = 0; n < octree.nodeCount; n++) if (octree.leafIndex[n] >= 0) m[octree.leafIndex[n]] = n;
  return m;
}

/**
 * 시야 안 리프마다 목표 단계를 정하고 점진 전송 조각 열을 만든다.
 * 리프 목표 단계 = 공용 화면 오차 규칙(screen_error.mjs)으로 d_eff = max(d·cMin², z_P·c_P) (screen_error.mjs 참조) 에서 고른 단계(최대 단계로 제한).
 * 같은 단계 안 순서의 '가까움' 은 카메라~리프 상자 최단 거리 d.
 * @returns {{level:number, leaf:number, indices:Uint32Array}[]}  indices 는 그 단계 대표점의 입력 점 번호(해당 리프 구간)
 */
export function progressiveChunks(hierarchy, camera, opts) {
  assertHierarchyInput(hierarchy);
  try {
    assertCamera(camera); // select/budget 와 같은 계약 검사. 오류는 'lod:' 로 옮긴다.
  } catch (e) {
    throw new Error(`${ERR} 카메라가 올바르지 않음 (${e.message})`);
  }
  const { octree, levels, edge0M } = hierarchy;
  const maxLevel = levels.length - 1;
  const rule = screenErrorRule(camera, { thresholdPx: opts?.thresholdPx, edge0M, levelCount: levels.length });
  const node = leafNodes(octree);

  const out = [];
  for (let k = 0; k < octree.leafCount; k++) {
    if (octree.leafStart[k + 1] === octree.leafStart[k]) continue; // 빈 리프
    const bmin = octree.boxMin.subarray(3 * node[k], 3 * node[k] + 3);
    const bmax = octree.boxMax.subarray(3 * node[k], 3 * node[k] + 3);
    if (!boxMayBeVisible(camera, bmin, bmax)) continue; // 시야 밖 리프는 조각 0
    const { distM: dist, level } = rule.leaf(bmin, bmax);
    const target = Math.min(maxLevel, level);
    // 최초 거친 조각 -> 목표 단계 조각(중간 단계는 건너뜀)
    const want = target === maxLevel ? [maxLevel] : [maxLevel, target];
    for (const l of want) {
      const lv = levels[l];
      const idx = lv.indices.slice(lv.leafStart[k], lv.leafStart[k + 1]);
      if (idx.length === 0) continue;
      out.push({ level: l, leaf: k, indices: idx, dist });
    }
  }
  out.sort((a, b) => b.level - a.level || a.dist - b.dist || a.leaf - b.leaf);
  return out.map(({ level, leaf, indices }) => ({ level, leaf, indices }));
}

/**
 * 앞 k 개 조각을 적용한 점군. 같은 리프의 나중 조각은 앞 조각을 교체한다(누적 금지).
 * 출력 순서는 리프 번호 오름차순, 리프 안에서는 그 단계 대표점 순서. 법선·색은 그 단계의 대표값.
 * @returns {import('../../../contracts/points/index.mjs').Point27Cloud}
 */
export function applyChunks(hierarchy, chunks, k) {
  assertHierarchyInput(hierarchy);
  if (!Array.isArray(chunks)) throw new Error(`${ERR} chunks 는 배열`);
  if (!Number.isInteger(k) || k < 0 || k > chunks.length) throw new Error(`${ERR} k 는 0..${chunks.length} 정수: ${String(k)}`);
  const { octree, levels } = hierarchy;
  const cur = new Map(); // leaf -> chunk (나중 것이 앞 것을 교체)
  for (let i = 0; i < k; i++) {
    const c = chunks[i];
    if (!c || typeof c !== 'object') throw new Error(`${ERR} 조각 ${i} 가 객체가 아님: ${String(c)}`);
    if (!Number.isInteger(c.level) || c.level < 0 || c.level >= levels.length) throw new Error(`${ERR} 조각 단계가 범위 밖: ${String(c.level)}`);
    if (!Number.isInteger(c.leaf) || c.leaf < 0 || c.leaf >= octree.leafCount) throw new Error(`${ERR} 조각 리프가 범위 밖: ${String(c.leaf)}`);
    if (!(c.indices instanceof Uint32Array)) throw new Error(`${ERR} 조각 ${i} 의 indices 는 Uint32Array`);
    const lv = levels[c.level];
    if (c.indices.length !== lv.leafStart[c.leaf + 1] - lv.leafStart[c.leaf]) throw new Error(`${ERR} 조각 점 수가 단계 ${c.level} 리프 ${c.leaf} 구간과 다름`);
    // 점 번호 대조는 건너뛰기 판정보다 앞에서 한다: 추월당해 버려질 조각도 틀린 번호면 오류여야 하므로,
    // 오류 여부가 조각 도착 순서에 달리지 않는다(F-107 ③).
    for (let j = 0, s0 = lv.leafStart[c.leaf]; j < c.indices.length; j++) {
      if (c.indices[j] !== lv.indices[s0 + j]) throw new Error(`${ERR} 조각 점 번호가 단계 ${c.level} 의 대표점과 다름`);
    }
    // 추월 규칙(RULES §1.1, 번호 규약: LOD 번호는 0 이 가장 곱다 — ASSET_FORMAT §10.1·10.2): 같은 리프에 이미 더 고운(작은 level) 조각이 있으면 늦게 온 더 거친(큰 level) 조각은 건너뛴다.
    // 같은 단계가 다시 오면 덮어쓰고(같은 내용), 더 고운 조각이 오면 교체한다. 그래서 도착 순서와 무관하게
    // 한 리프의 결과는 받은 조각 중 가장 고운 단계 하나로 정해진다.
    const p = cur.get(c.leaf);
    if (p && c.level > p.level) continue;
    cur.set(c.leaf, c);
  }
  const leaves = [...cur.keys()].sort((a, b) => a - b);
  let n = 0;
  for (const l of leaves) n += cur.get(l).indices.length;
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
  let o = 0;
  for (const l of leaves) {
    const c = cur.get(l), lv = levels[c.level], s0 = lv.leafStart[l], m = c.indices.length;
    if (m === 0) continue;
    // 위치도 법선·색처럼 그 단계의 levels[l].positions(build 때 담은 입력 위치 사본)에서 구간째 복사한다.
    // materialize 와 같은 출처라 두 경로 결과가 바이트 동일하다(F-107 ④). 점 번호 대조는 위 입력 검사에서 끝났다.
    positions.set(lv.positions.subarray(3 * s0, 3 * (s0 + m)), 3 * o);
    normals.set(lv.normals.subarray(3 * s0, 3 * (s0 + m)), 3 * o);
    colors.set(lv.colors.subarray(3 * s0, 3 * (s0 + m)), 3 * o);
    o += m;
  }
  return { format: 1, count: n, positions, normals, colors };
}
