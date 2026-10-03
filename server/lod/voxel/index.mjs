// 격자 대표점 축소(T07.1). 한 변 edgeM 인 정육면체 칸마다 입력 점 하나만 남긴다.
// 새 점을 만들지 않고 입력 점의 부분집합만 고른다(skylens 원칙).
import { assertCloud } from '../../../contracts/lod/index.mjs';

/**
 * 칸 = floor(x/edge) 정수 3-튜플. 칸 번호는 튜플 사전순(오름차순).
 * 대표점 = 칸 중심 (k+0.5)·edge 에 가장 가까운 입력 점, 동률이면 입력 번호가 작은 점.
 * @param {import('../../../contracts/points/index.mjs').Point27Cloud} cloud
 * @param {number} edgeM 양의 유한수
 * @returns {import('../../../contracts/lod/index.mjs').VoxelResult}
 */
export function voxelReduce(cloud, edgeM) {
  const n = assertCloud(cloud);
  if (!(typeof edgeM === 'number' && Number.isFinite(edgeM) && edgeM > 0)) throw new Error(`lod: edgeM 은 양의 유한수: ${String(edgeM)}`);
  const p = cloud.positions;
  // 칸 좌표(정수값 double). Float32 를 double 로 읽어 나눈다.
  const k = new Float64Array(3 * n);
  for (let i = 0; i < 3 * n; i++) {
    const v = Math.floor(p[i] / edgeM);
    if (!Number.isFinite(v)) throw new Error('lod: edgeM 이 너무 작아 칸 좌표가 유한하지 않음');
    k[i] = v;
  }
  // 칸 키 오름차순, 같은 칸 안에서는 입력 번호 오름차순으로 정렬.
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => {
    for (let d = 0; d < 3; d++) {
      const diff = k[3 * a + d] - k[3 * b + d];
      if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return a - b;
  });

  const repList = [];
  const cellOfPoint = new Uint32Array(n);
  let cell = -1;
  let best = -1, bestD = Infinity;
  for (let s = 0; s < n; s++) {
    const i = order[s];
    let same = false;
    if (s > 0) {
      const j = order[s - 1];
      same = k[3 * i] === k[3 * j] && k[3 * i + 1] === k[3 * j + 1] && k[3 * i + 2] === k[3 * j + 2];
    }
    if (!same) {
      if (cell >= 0) repList.push(best);
      cell++;
      best = -1; bestD = Infinity;
    }
    cellOfPoint[i] = cell;
    let d2 = 0;
    for (let d = 0; d < 3; d++) {
      const c = (k[3 * i + d] + 0.5) * edgeM;
      const t = p[3 * i + d] - c;
      d2 += t * t;
    }
    // 같은 칸 안에서 번호 오름차순으로 훑으므로 엄격한 '<' 이면 동률은 번호 작은 점이 남는다.
    if (d2 < bestD) { bestD = d2; best = i; }
  }
  if (cell >= 0) repList.push(best);
  return { edgeM, count: cell + 1, rep: Uint32Array.from(repList), cellOfPoint };
}
