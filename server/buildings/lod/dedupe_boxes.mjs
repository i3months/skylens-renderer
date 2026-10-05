// 같은 자리 동일·포함 상자 접기(F-330). 한 방향 묶음의 단일 건물 요소(toFrame 결과)에서, 다른 요소의 상자 안에
// 완전히 들어가고 높이도 그 이하인 요소를 군집 후보에서 뺀다. 같은 자리 동일 상자 N 채가 응집 단계에서 쌍 N^2 개를
// 만들어 초선형이 되는 것을 막는다. 빠진 요소는 대표 상자 안에 가려지므로 출력 상자는 같다(ids 는 호출 쪽이 따로 유지한다).
const EPS = 1e-9;

// 마지막 호출의 입출력 수(시험이 접기가 실제로 쓰였는지 확인한다).
export const foldStats = { calls: 0, input: 0, output: 0 };

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

// a 가 b 를 가린다: b 의 상자가 a 안, 높이(윗면·바닥)도 안이고, a 가 직사각형이거나 b 와 풋프린트가 같다.
// b 의 지붕 최저(roofMin)·오차는 보지 않는다: b 는 a 의 상자 안에서 a 의 지붕 아래에 있어 합친 상자로 가려지고, 둘 다 singleError 를 통과했다.
// a 의 원본이 상자보다 작아 원본 유지될 수 있으면(삼각형 10개 미만) 대표가 될 수 없다.
// z 비교 허용 오차(m). 바닥이 이만큼 나온 건 지워지는 세부 크기(hideTol, 500 m 이상에서 0.12 m 이상)보다 훨씬 작다.
// minZ 가 mm 만 달라도 대표가 되면 같은 자리 N 채가 응집에서 N^2 쌍을 만든다.
export const FOLD_Z_TOL_M = 0.01;

function covers(a, b) {
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
  const reps = [];
  const dropped = new Set();
  for (const m of sorted) {
    m.rect = isRect(m);
    let hidden = false;
    for (const r of reps) if (covers(r, m)) { hidden = true; break; }
    if (hidden) dropped.add(m); else if (m.it.mesh.indices.length / 3 >= 10) reps.push(m);
  }
  const live = singles.filter((m) => !dropped.has(m));
  foldStats.output += live.length;
  return live;
}
