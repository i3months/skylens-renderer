// 같은 자리 동일·포함 상자 접기(F-330). 한 방향 묶음의 단일 건물 요소(toFrame 결과)에서, 다른 요소의 상자 안에
// 완전히 들어가고 높이도 그 이하(최대 FOLD_Z_TOL_M = 1 cm 튀어나온 것까지 포함)인 요소를 군집 후보에서 뺀다. 같은 자리 동일 상자 N 채가 응집 단계에서 쌍 N^2 개를
// 만들어 초선형이 되는 것을 막는다. 빠진 요소는 대표 상자 안에 가려지므로 출력 상자는 같다(ids 는 호출 쪽이 따로 유지한다).
// 대가: 대표보다 위·아래로 최대 1 cm 튀어나온 상자도 접혀 그 1 cm 는 출력 상자에서 빠질 수 있다.
// 대표 탐색은 minZ 순위 위의 구간 트리(노드 최대 maxZ)로 z 조건을 만족하는 대표만 방문한다. 비용은 z 로 쌓인 경우(대표가 줄지 않는 1~5 cm 간격 포함)에만 선형에 가깝다:
// 같은 z 에서 xy 로만 갈라진 상자는 z 조건을 모두 만족하므로 여전히 입력 × 대표 수다(F-371: xy 색인은 하지 않았다).
const EPS = 1e-9;

// 마지막 호출의 입출력 수(시험이 접기가 실제로 쓰였는지 확인한다).
// covers: covers() 호출 수(작업량 계수; 선형 비교면 입력×대표, 색인이면 입력×(z 허용 안 대표 수)).
export const foldStats = { calls: 0, input: 0, output: 0, covers: 0 };

// 풋프린트가 상자 전체를 채우는 직사각형인가: 넓이 있는 삼각형의 모든 꼭짓점이 상자 모서리에 있다.
function isRect(m) {
  const f = m.fill;
  if (!f.length) return false;
  for (let o = 0; o < f.length; o += 2) {
    if (Math.abs(f[o] - m.minX) > EPS && Math.abs(f[o] - m.maxX) > EPS) return false;
    if (Math.abs(f[o + 1] - m.minY) > EPS && Math.abs(f[o + 1] - m.maxY) > EPS) return false;
  }
  return true;
}

function sameFill(a, b) {
  if (a.fill.length !== b.fill.length) return false;
  for (let i = 0; i < a.fill.length; i++) if (Math.abs(a.fill[i] - b.fill[i]) > EPS) return false;
  return true;
}

// a 가 b 를 가린다: b 의 상자가 a 안, 높이(윗면·바닥)도 안(각각 FOLD_Z_TOL_M 까지 벗어나도 됨)이고, a 가 직사각형이거나 b 와 풋프린트가 같다.
// b 의 지붕 최저(roofMin)·오차는 보지 않는다: b 는 a 의 상자 안에서 a 의 지붕 아래에 있어 합친 상자로 가려지고, 둘 다 singleError 를 통과했다.
// a 의 원본이 상자보다 작아 원본 유지될 수 있으면(삼각형 10개 미만) 대표가 될 수 없다.
// z 비교 허용 오차(m). 바닥이 이만큼 나온 건 지워지는 세부 크기(hideTol, 500 m 이상에서 0.12 m 이상)보다 훨씬 작다.
// minZ 가 mm 만 달라도 대표가 되면 같은 자리 N 채가 응집에서 N^2 쌍을 만든다.
export const FOLD_Z_TOL_M = 0.01;

function covers(a, b) {
  foldStats.covers++;
  if (b.minX < a.minX - EPS || b.maxX > a.maxX + EPS || b.minY < a.minY - EPS || b.maxY > a.maxY + EPS) return false;
  if (b.maxZ > a.maxZ + FOLD_Z_TOL_M || b.minZ < a.minZ - FOLD_Z_TOL_M) return false;
  return a.rect || sameFill(a, b);
}

export function foldContained(singles) {
  foldStats.calls++;
  foldStats.input += singles.length;
  if (singles.length < 2) { foldStats.output += singles.length; return singles; }
  const area = (m) => (m.maxX - m.minX) * (m.maxY - m.minY);
  // 큰 상자·높은 건물 먼저, 동률이면 입력 순서. 이미 남긴 대표만 비교하므로 동일 상자 N 채는 N 번 비교로 끝난다.
  const sorted = singles
    .slice()
    .sort((p, q) => area(q) - area(p) || q.maxZ - p.maxZ || p.order - q.order);
  // minZ 순위(전체 입력 기준)별 구간 트리: 노드마다 대표들의 최대 maxZ. 가지치기는 보수적(1e-6 여유)이고 판정은 covers 가 한다.
  const zs = Array.from(new Set(singles.map((m) => m.minZ))).sort((p, q) => p - q);
  const rankOf = new Map(zs.map((z, i) => [z, i]));
  let size = 1;
  while (size < zs.length) size <<= 1;
  const top = new Float64Array(2 * size).fill(-Infinity);
  const leaves = new Array(zs.length);
  const SLACK = 1e-6;
  const upperRank = (z) => { // minZ <= z 인 순위 수
    let lo = 0, hi = zs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (zs[mid] <= z) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const find = (node, lo, hi, lim, minTop, m) => { // 순위 [lo,hi) 중 lim 미만만
    if (lo >= lim || top[node] < minTop) return false;
    if (hi - lo === 1) {
      for (const r of leaves[lo] ?? []) if (covers(r, m)) return true;
      return false;
    }
    const mid = (lo + hi) >> 1;
    return find(2 * node, lo, mid, lim, minTop, m) || find(2 * node + 1, mid, hi, lim, minTop, m);
  };
  const add = (m) => {
    const k = rankOf.get(m.minZ);
    (leaves[k] ||= []).push(m);
    for (let i = size + k; i >= 1; i >>= 1) if (top[i] < m.maxZ) top[i] = m.maxZ;
  };
  const dropped = new Set();
  for (const m of sorted) {
    m.rect = isRect(m);
    const hidden = find(1, 0, size, upperRank(m.minZ + FOLD_Z_TOL_M + SLACK), m.maxZ - FOLD_Z_TOL_M - SLACK, m);
    if (hidden) dropped.add(m); else if (m.it.mesh.indices.length / 3 >= 10) add(m);
  }
  const live = singles.filter((m) => !dropped.has(m));
  foldStats.output += live.length;
  return live;
}
