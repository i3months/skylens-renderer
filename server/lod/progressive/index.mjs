// T07.9 점진 순서(거친 단계 먼저). 계약: contracts/lod/index.mjs 의 LOD_API.progressive.
// select 모듈에 의존하지 않는다: 리프의 목표 단계는 이 모듈 안에서 distance_table 로 직접 계산한다.
//
// 델레이 패턴(RULES §1.1): 같은 구간(리프)의 낮은 단계는 높은 단계로 "교체"한다(누적 아님),
//   이미 추월당한 중간 단계는 건너뛴다. 그래서 한 리프의 조각은 최대 2개다.
//     목표 T == 최대 단계  -> [최대 단계 조각]
//     목표 T <  최대 단계  -> [최대 단계 조각, T 단계 조각]   (사이 단계는 보내지 않음)
// 조각 순서: 거친 단계(큰 level) 먼저, 같은 단계 안에서는 카메라에 가까운 리프 먼저(동률이면 리프 번호).
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { buildDistanceTable, levelForDistance } from '../distance_table/index.mjs';

const ERR = 'lod:';
const NEAR_EPS = 1e-6; // 카메라 앞 판정 하한(m)
const MIN_DIST_M = 1e-9; // 거리 0(카메라가 상자 안) 일 때 distance_table 에 넘길 최소 거리

/** 카메라 중심(세계 좌표): X_c = R·X_w + t 이므로 C = −Rᵀ·t. */
function cameraCenter({ R, t }) {
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

/** 상자(min,max)가 시야 절두체와 겹칠 수 있는가(보수적: 확실히 밖일 때만 false). */
function boxInView(camera, bmin, bmax) {
  const { R, t, K, width, height } = camera;
  // 8 모서리를 카메라 좌표로
  const cx = new Float64Array(8), cy = new Float64Array(8), cz = new Float64Array(8);
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? bmax[0] : bmin[0], y = c & 2 ? bmax[1] : bmin[1], z = c & 4 ? bmax[2] : bmin[2];
    cx[c] = R[0] * x + R[1] * y + R[2] * z + t[0];
    cy[c] = R[3] * x + R[4] * y + R[5] * z + t[1];
    cz[c] = R[6] * x + R[7] * y + R[8] * z + t[2];
  }
  // 반공간 5개: 안쪽이면 값 ≥ 0. 한 반공간에서 8 모서리가 모두 밖이면 상자는 시야 밖.
  const planes = [
    (i) => cz[i] - NEAR_EPS,
    (i) => K.fx * cx[i] + K.cx * cz[i],
    (i) => (width - K.cx) * cz[i] - K.fx * cx[i],
    (i) => K.fy * cy[i] + K.cy * cz[i],
    (i) => (height - K.cy) * cz[i] - K.fy * cy[i],
  ];
  for (const f of planes) {
    let anyIn = false;
    for (let i = 0; i < 8 && !anyIn; i++) if (f(i) >= 0) anyIn = true;
    if (!anyIn) return false;
  }
  return true;
}

/** 점 C 에서 상자까지의 최단 거리. */
function distToBox(c, bmin, bmax) {
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const d = c[a] < bmin[a] ? bmin[a] - c[a] : c[a] > bmax[a] ? c[a] - bmax[a] : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

/** 리프 번호 -> 노드 번호(octree.leafIndex 의 역) */
function leafNodes(octree) {
  const m = new Int32Array(octree.leafCount);
  for (let n = 0; n < octree.nodeCount; n++) if (octree.leafIndex[n] >= 0) m[octree.leafIndex[n]] = n;
  return m;
}

/**
 * 시야 안 리프마다 목표 단계를 정하고 점진 전송 조각 열을 만든다.
 * 리프 목표 단계 = levelForDistance(거리표, 카메라~리프 상자 최단 거리) (최대 단계로 제한).
 * @returns {{level:number, leaf:number, indices:Uint32Array}[]}  indices 는 그 단계 대표점의 입력 점 번호(해당 리프 구간)
 */
export function progressiveChunks(hierarchy, camera, opts) {
  if (!hierarchy || !hierarchy.octree || !Array.isArray(hierarchy.levels) || hierarchy.levels.length < 1) throw new Error(`${ERR} 계층이 아님`);
  try {
    assertCamera(camera); // select/budget 와 같은 계약 검사. 오류는 'lod:' 로 옮긴다.
  } catch (e) {
    throw new Error(`${ERR} 카메라가 올바르지 않음 (${e.message})`);
  }
  const { octree, levels, edge0M } = hierarchy;
  const maxLevel = levels.length - 1;
  const table = buildDistanceTable({ fx: camera.K.fx, thresholdPx: opts?.thresholdPx, edge0M, levelCount: levels.length });
  const center = cameraCenter(camera);
  const node = leafNodes(octree);

  const out = [];
  for (let k = 0; k < octree.leafCount; k++) {
    if (octree.leafStart[k + 1] === octree.leafStart[k]) continue; // 빈 리프
    const bmin = octree.boxMin.subarray(3 * node[k], 3 * node[k] + 3);
    const bmax = octree.boxMax.subarray(3 * node[k], 3 * node[k] + 3);
    if (!boxInView(camera, bmin, bmax)) continue; // 시야 밖 리프는 조각 0
    const dist = distToBox(center, bmin, bmax);
    const target = Math.min(maxLevel, levelForDistance(table, Math.max(dist, MIN_DIST_M)));
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
  if (!Array.isArray(chunks)) throw new Error(`${ERR} chunks 는 배열`);
  if (!Number.isInteger(k) || k < 0 || k > chunks.length) throw new Error(`${ERR} k 는 0..${chunks.length} 정수: ${String(k)}`);
  const { cloud, octree, levels } = hierarchy;
  const cur = new Map(); // leaf -> chunk (나중 것이 앞 것을 교체)
  for (let i = 0; i < k; i++) {
    const c = chunks[i];
    if (!Number.isInteger(c.level) || c.level < 0 || c.level >= levels.length) throw new Error(`${ERR} 조각 단계가 범위 밖: ${String(c.level)}`);
    if (!Number.isInteger(c.leaf) || c.leaf < 0 || c.leaf >= octree.leafCount) throw new Error(`${ERR} 조각 리프가 범위 밖: ${String(c.leaf)}`);
    const lv = levels[c.level];
    if (c.indices.length !== lv.leafStart[c.leaf + 1] - lv.leafStart[c.leaf]) throw new Error(`${ERR} 조각 점 수가 단계 ${c.level} 리프 ${c.leaf} 구간과 다름`);
    cur.set(c.leaf, c);
  }
  const leaves = [...cur.keys()].sort((a, b) => a - b);
  let n = 0;
  for (const l of leaves) n += cur.get(l).indices.length;
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
  let o = 0;
  for (const l of leaves) {
    const c = cur.get(l), lv = levels[c.level], s0 = lv.leafStart[l];
    for (let j = 0; j < c.indices.length; j++, o++) {
      const i = c.indices[j];
      if (i !== lv.indices[s0 + j]) throw new Error(`${ERR} 조각 점 번호가 단계 ${c.level} 의 대표점과 다름`);
      positions.set(cloud.positions.subarray(3 * i, 3 * i + 3), 3 * o);
      normals.set(lv.normals.subarray(3 * (s0 + j), 3 * (s0 + j) + 3), 3 * o);
      colors.set(lv.colors.subarray(3 * (s0 + j), 3 * (s0 + j) + 3), 3 * o);
    }
  }
  return { format: 1, count: n, positions, normals, colors };
}
