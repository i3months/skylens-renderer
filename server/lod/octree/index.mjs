// 팔진 트리(T07.2). 계약: contracts/lod/index.mjs 의 Octree. 점을 옮기거나 만들지 않고 "어느 리프에 속하는지"만 정한다.
// 노드 번호는 너비 우선(BFS) 순서: 루트 = 0, 한 노드의 자식은 firstChild.. 에 연속, 리프 번호는 노드 번호 순.
// 상자는 정육면체(루트 = 점 경계 상자의 가장 긴 변). 자식은 중심 기준 8분할이며 좌표 >= 중심이면 상위 칸에 든다.
// 자식 번호 = (x>=cx ? 1 : 0) + (y>=cy ? 2 : 0) + (z>=cz ? 4 : 0) 오름차순, 비어 있는 자식은 만들지 않는다.
import { assertCloud } from '../../../contracts/lod/index.mjs';

const ERR = 'lod:';
/** 퇴화(모든 점이 한 곳) 입력의 루트 한 변(m). 크기 0 상자를 피하려는 값. */
const DEGENERATE_SIDE = 1;
const F32_EPS = 2 ** -23;
const F32_TINY = 2 ** -149;
/** Float32 로 표현되는 최댓값. 바깥 반올림·정육면체 확장이 이를 넘으면 Infinity 가 되므로 상자를 여기서 자른다. */
const F32_MAX = 3.4028234663852886e38;

// Float32 로 저장해도 상자가 점을 놓치지 않도록 바깥쪽으로 반올림한다(최소는 내림, 최대는 올림).
function f32Down(v) {
  let f = Math.fround(v);
  if (f > v) f = Math.fround(f - Math.max(Math.abs(f) * F32_EPS, F32_TINY));
  return f;
}
function f32Up(v) {
  let f = Math.fround(v);
  if (f < v) f = Math.fround(f + Math.max(Math.abs(f) * F32_EPS, F32_TINY));
  return f;
}

function checkOptions(opts) {
  const { maxLeafPoints = 4096, maxDepth = 12 } = opts ?? {};
  if (!Number.isInteger(maxLeafPoints) || maxLeafPoints < 1) throw new Error(`${ERR} maxLeafPoints 는 1 이상의 정수: ${String(maxLeafPoints)}`);
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 30) throw new Error(`${ERR} maxDepth 는 0..30 정수: ${String(maxDepth)}`);
  return { maxLeafPoints, maxDepth };
}

/**
 * 점군으로 팔진 트리를 만든다. 같은 입력이면 결과도 같다(난수·해시 순서 없음).
 * 깊이가 maxDepth 에 닿으면 점이 maxLeafPoints 를 넘어도 리프로 둔다(같은 위치 점이 많아도 분할은 유한).
 * 점이 없으면 빈 리프 하나(루트)만 가진다.
 * @param {import('../../../contracts/lod/index.mjs').Point27Cloud} cloud
 * @param {{maxLeafPoints?: number, maxDepth?: number}} [opts]
 * @returns {import('../../../contracts/lod/index.mjs').Octree}
 */
export function buildOctree(cloud, opts) {
  const n = assertCloud(cloud);
  const { maxLeafPoints, maxDepth } = checkOptions(opts);
  const pos = cloud.positions;

  // 경계 상자 → 정육면체 루트
  let mn = [0, 0, 0], mx = [0, 0, 0];
  if (n > 0) {
    mn = [Infinity, Infinity, Infinity]; mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
      const v = pos[3 * i + a];
      if (v < mn[a]) mn[a] = v;
      if (v > mx[a]) mx[a] = v;
    }
  }
  const side = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  const rootHalf = (side > 0 ? side : DEGENERATE_SIDE) / 2;

  // 노드 배열(BFS 순서로 자라는 일반 배열)
  const nStart = [0], nEnd = [n], nDepth = [0];
  const nCx = [(mn[0] + mx[0]) / 2], nCy = [(mn[1] + mx[1]) / 2], nCz = [(mn[2] + mx[2]) / 2], nHalf = [rootHalf];
  const firstChild = [-1], childCount = [0];

  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const tmp = new Uint32Array(n);
  const oct = new Uint8Array(n); // idx 위치별 칸 번호(범위 안에서만 쓰임)

  // 번호가 커지며 큐 역할을 한다: node 를 순서대로 처리하면 자식이 끝에 연속으로 붙는다.
  for (let node = 0; node < nStart.length; node++) {
    const s = nStart[node], e = nEnd[node];
    if (e - s <= maxLeafPoints || nDepth[node] >= maxDepth) continue; // 리프
    const cx = nCx[node], cy = nCy[node], cz = nCz[node];
    const counts = new Array(8).fill(0);
    for (let k = s; k < e; k++) {
      const p = idx[k];
      const o = (pos[3 * p] >= cx ? 1 : 0) | (pos[3 * p + 1] >= cy ? 2 : 0) | (pos[3 * p + 2] >= cz ? 4 : 0);
      oct[k] = o; counts[o]++;
    }
    // 안정 계수 정렬: 칸 번호 오름차순, 칸 안에서는 기존 순서 유지
    const offs = new Array(8);
    let acc = s;
    for (let o = 0; o < 8; o++) { offs[o] = acc; acc += counts[o]; }
    const cursor = offs.slice();
    for (let k = s; k < e; k++) tmp[cursor[oct[k]]++] = idx[k];
    idx.set(tmp.subarray(s, e), s);

    const h = nHalf[node] / 2;
    firstChild[node] = nStart.length;
    let made = 0;
    for (let o = 0; o < 8; o++) {
      if (counts[o] === 0) continue;
      nStart.push(offs[o]); nEnd.push(offs[o] + counts[o]); nDepth.push(nDepth[node] + 1);
      nCx.push(cx + (o & 1 ? h : -h)); nCy.push(cy + (o & 2 ? h : -h)); nCz.push(cz + (o & 4 ? h : -h));
      nHalf.push(h);
      firstChild.push(-1); childCount.push(0);
      made++;
    }
    childCount[node] = made;
  }

  const nodeCount = nStart.length;
  const leafIndex = new Int32Array(nodeCount).fill(-1);
  let leafCount = 0;
  for (let i = 0; i < nodeCount; i++) if (firstChild[i] < 0) leafIndex[i] = leafCount++;

  // 리프 순서(노드 번호 순)로 점 번호를 재배열
  const leafStart = new Uint32Array(leafCount + 1);
  const order = new Uint32Array(n);
  let w = 0;
  for (let i = 0; i < nodeCount; i++) {
    const k = leafIndex[i];
    if (k < 0) continue;
    leafStart[k] = w;
    for (let q = nStart[i]; q < nEnd[i]; q++) order[w++] = idx[q];
  }
  leafStart[leafCount] = w;

  const boxMin = new Float32Array(3 * nodeCount), boxMax = new Float32Array(3 * nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const c = [nCx[i], nCy[i], nCz[i]], h = nHalf[i];
    for (let a = 0; a < 3; a++) { // 정육면체 루트가 Float32 범위를 넘으면 Infinity 가 되어 계층 검사가 빌더 자신의 계층을 거부했다(F-112 ②).
      // 점 좌표는 Float32 이므로 ±F32_MAX 안에 있어, 자른 상자도 점을 놓치지 않는다.
      boxMin[3 * i + a] = Math.max(f32Down(c[a] - h), -F32_MAX); boxMax[3 * i + a] = Math.min(f32Up(c[a] + h), F32_MAX); }
  }

  return {
    nodeCount, leafCount,
    firstChild: Int32Array.from(firstChild),
    childCount: Uint8Array.from(childCount),
    leafIndex, boxMin, boxMax, leafStart, order,
  };
}
