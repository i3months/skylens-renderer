// F-360: 지붕 넓이 검사의 비용 상한과 근거리 생략. F-355: 삼각형 쪽·벽 쪽 감김을 따로 센다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingLod, windingStats, distStats, summarizeStats, WINDING_WORK_CAP } from './index.mjs';
import { prism } from './scene.mjs';

// 같은 높이(z=5) 직사각 지붕을 L 장 겹쳐 쌓은 메시(한 장은 삼각형 2개, 층마다 가장자리를 0.01 m 씩 안쪽으로).
// 합집합은 가장 바깥 직사각 하나라 상자와 일치(오차 0)하고, 선분이 서로 상쇄되지 않아 작업량이 L² 으로 는다.
// 작업량 상한(400000)은 L=150 에서는 아래, L=160 부터는 위다(측정: roof_area 시험 작성 때 L=150 으로 상자, 160 으로 원본 유지 확인).
function layers(L, ox = 0, oy = 0) {
  const pos = [], idx = [];
  for (let i = 0; i < L; i++) {
    const e = i * 0.01, o = pos.length / 3;
    pos.push(ox + e, oy + e * 1.3, 5, ox + 30 - e, oy + e * 1.3, 5, ox + 30 - e, oy + 30 - e * 0.7, 5, ox + e, oy + 30 - e * 0.7, 5);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
// F-370: 벽시계 대신 작업량 계수(windingStats·distStats)로 판정한다. 계수는 결정적이라 병렬 부하와 무관하다.
// 비율 기준 RATIO_MAX: 입력을 2 배로 할 때 선형 작업은 2.0 배, 이차 작업은 4.0 배다. 2.2 = 선형 + 10 %(구간·경계 반올림 여유)이고
// 이차와는 크게 갈린다. 측정값에 맞춘 값이 아니라 이 두 극 사이에서 정했다.
const RATIO_MAX = 2.2;
const resetStats = () => {
  Object.assign(windingStats, { calls: 0, segs: 0, kept: 0, active: 0, capped: 0, probes: 0, moves: 0 });
  Object.assign(distStats, { segs: 0, frameSegs: 0, addCalls: 0, probes: 0 });
  Object.assign(summarizeStats, { calls: 0, tris: 0, wallLookups: 0, wallProbes: 0 });
};
// 해시 표 탐사 수 상한 배수: 열린 주소 표는 적재율 ≤ 1/2 로 만들어(cap ≥ 2·원소 수) 한 번 조회가 평균 1.5~2.5 칸이다(선형 탐사 이론값 0.5(1+1/(1-α)²) = 2.5).
// 4 = 이론 평균의 1.6 배 여유. 선형 탐색(표를 훑는 구현)이면 조회당 표 크기에 비례해 이 배수를 크게 넘는다.
const PROBE_MULT = 4;
const fan = (T) => {
  const pos = [0, 0, 5];
  for (let i = 0; i <= T; i++) { const a = ((Math.PI * 2 * i) / T) * 0.9; pos.push(30 * Math.cos(a), 30 * Math.sin(a), 5); }
  const idx = [];
  for (let i = 1; i <= T; i++) idx.push(0, i, i + 1);
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
};
const grid = (ox, oy, N = 20) => {
  const pos = [], idx = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) pos.push(ox + i + Math.sin(i * 7.1 + j * 3.3) * 0.3, oy + j + Math.cos(i * 2.9 + j * 5.7) * 0.3, 5);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; idx.push(a, b, d, a, d, c); }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
};

// 원통 프리즘은 벽 방향이 하나로 지배되지 않아(원) 지붕 검사·거리 측정에 들어가기 전에 원본으로 남는다. 그래서 n 이 커져도 지붕·거리 계수는 0 이다.
// 이 시험은 그 경로가 이차 작업 쪽으로 바뀌지 않았는지(계수가 0 이 아니게 되면 비율 시험으로 바꿔야 한다) 지킨다.
// 그러나 요약(summarize)은 이 경로에서도 돈다: 벽 n 개를 중복 제거 표에 조회한다. F-370 검토 #3: 요약 계수(summarizeStats)로 이차 회귀를 잡는다.
// 구성에서 따라 나오는 값: 프리즘 한 동은 벽 사각 n 개 = 벽 삼각형 2n 개(같은 선분이라 두 번째는 표에서 이미 있음)이므로 wallLookups = 2n 이고,
// 서로 다른 벽 선분은 n 개다. 탐사 수는 조회당 평균 1.5~2.5 칸이라 상한 PROBE_MULT·조회 수, 선형 탐색이면 조회당 최대 n 칸이라 n² 규모다.
test('n=2048·4096 원통 프리즘 한 동은 원본 유지이고 지붕·거리 계수는 0, 요약 탐사는 조회 수에 선형', () => {
  const sums = [];
  for (const n of [2048, 4096]) {
    const ring = [];
    for (let i = 0; i < n; i++) ring.push([20 * Math.cos((2 * Math.PI * i) / n), 20 * Math.sin((2 * Math.PI * i) / n)]);
    const mesh = prism(ring, 3);
    for (const dist of [300, 5000]) {
      resetStats();
      const out = buildBuildingLod([{ id: 1, mesh }], dist);
      assert.ok(same(out[0].mesh.indices, mesh.indices), `${n}·${dist} m: 원본 유지`);
      assert.equal(windingStats.active + distStats.segs + distStats.frameSegs, 0, `${n}·${dist} m`);
      // 양성 대조: 요약 계수가 실제로 돈다(0 이면 아래 상한이 비어 버린다).
      assert.equal(summarizeStats.calls, 1, `${n}·${dist} m`);
      assert.equal(summarizeStats.wallLookups, 2 * n, `${n}·${dist} m: 벽 조회 수`);
      assert.ok(summarizeStats.wallProbes >= summarizeStats.wallLookups, `${n}·${dist} m: 조회마다 최소 한 칸`);
      assert.ok(summarizeStats.wallProbes <= PROBE_MULT * summarizeStats.wallLookups, `${n}·${dist} m: 탐사 ${summarizeStats.wallProbes} > ${PROBE_MULT}·${summarizeStats.wallLookups}`);
    }
    sums.push(summarizeStats.wallProbes);
  }
  assert.ok(sums[1] / sums[0] <= RATIO_MAX, `탐사 n=2048 ${sums[0]}, n=4096 ${sums[1]}`);
});

// 부채꼴 삼각형 T 개(위 향함, 자기 상자와의 오차가 커서 원본 유지)의 지붕 검사 작업: 활성 선분 합이 T 에 선형이고 상한 아래.
test('위 향한 부채꼴 삼각형 한 동: 원본 유지, 활성 선분 합은 T 에 선형(T 2 배 → ≤ 2.2 배)이고 작업량 상한 아래', () => {
  const run = (T) => {
    const mesh = fan(T);
    resetStats();
    const out = buildBuildingLod([{ id: 1, mesh }], 5000);
    assert.ok(same(out[0].mesh.indices, mesh.indices), `T=${T}: 원본 유지`);
    return { ...windingStats };
  };
  const a = run(5000), b = run(10000);
  assert.equal(b.capped, 0);
  // 공유 변 상쇄 뒤 남는 선분은 경계뿐이다: 바깥 호 T 개 + 반지름 2 개, 검사 두 번(foot·up) 합쳐 2 × (T + 2). 상쇄가 빠지면 6 T(삼각형 변 3 개 × 2 번)로 는다.
  assert.ok(b.kept <= 2 * (10000 + 2) + 4, `남은 선분 ${b.kept}`);
  assert.ok(b.active <= WINDING_WORK_CAP, `활성 합 ${b.active}`);
  assert.ok(b.active / a.active <= RATIO_MAX, `활성 합 T=5000 ${a.active}, T=10000 ${b.active}`);
});

// F-368 ①: 상한을 넘으면 '통과' 가 아니라 원본 유지다. 같은 모양의 상한 아래 메시는 20000 m 에서 상자 10삼각형이 되므로 상한만 다르다.
test('작업량 상한을 넘는 메시는 20000 m 에서도 원본 유지, 상한 아래 같은 모양은 상자', () => {
  const under = layers(150), over = layers(200);
  const u = buildBuildingLod([{ id: 1, mesh: under }], 20000);
  assert.equal(u[0].mesh.indices.length / 3, 10, '상한 아래는 상자(오차 0)');
  const o = buildBuildingLod([{ id: 1, mesh: over }], 20000);
  assert.ok(same(o[0].mesh.indices, over.indices), '상한 초과는 원본 유지');
  assert.ok(same(o[0].mesh.positions, over.positions));
});

// F-368 ②: 근거리 생략. 근거리(300 m)에서는 지붕 넓이 검사가 한 번도 불리지 않고(windingArea 호출 0), 같은 입력이 원거리에서는 동마다 두 번(foot·up) 불린다.
// 호출 계수라 근거리에서 검사를 하도록 바뀐 변이에서 바로 실패한다(벽시계 시험이 아님).
test('근거리(300 m)는 상한 아래 비싼 메시 200동에서도 지붕 넓이 검사를 부르지 않는다', () => {
  const bs = [];
  for (let k = 0; k < 200; k++) bs.push({ id: k + 1, mesh: layers(150, (k % 15) * 40, Math.floor(k / 15) * 40) });
  resetStats();
  buildBuildingLod(bs, 300);
  assert.equal(windingStats.calls, 0);
  assert.equal(windingStats.active, 0);
  // 대조: 같은 입력이 원거리에서는 검사가 실제로 돈다. 위 단언이 빈 시험이 아님을 보인다.
  resetStats();
  buildBuildingLod(bs, 5000);
  assert.equal(windingStats.calls, 400, '동마다 foot·up 두 번');
  assert.ok(windingStats.active > 0);
});

// F-368 ③: 양성 대조. 상한 아래의 정상 프리즘은 원거리에서 상자가 된다(상한 0 이면 전부 원본 유지가 되어 이 시험이 깨진다).
test('상한 아래 정상 프리즘(한 변에 꼭짓점이 하나 더 있는 30x30x3 m)은 원거리에서 상자 10삼각형', () => {
  // 원본은 10삼각형이 아니어야 상자와 구분된다(지붕 3삼각형 + 벽 10삼각형).
  const mesh = prism([[0, 0], [15, 0], [30, 0], [30, 30], [0, 30]], 3);
  assert.ok(mesh.indices.length / 3 > 10);
  for (const dist of [3000, 5000, 20000]) {
    const out = buildBuildingLod([{ id: 1, mesh }], dist);
    assert.equal(out.length, 1);
    assert.equal(out[0].mesh.indices.length / 3, 10, `${dist} m`);
    assert.ok(!same(out[0].mesh.indices, mesh.indices), `${dist} m`);
  }
});

// F-367: 삼각형 800개 격자 지붕(정점 xy 를 0.3 m 흔든 것) 200동 원거리 5000 m 빌드. 개선 전 약 4.2~6.3 s, 지금 0.3~0.6 s(Node 22, 4코어, 참고용 측정이고 시험은 시간을 보지 않는다).
// 판정은 계수: (1) 공유 변 상쇄가 격자 안쪽 변을 지워 한 검사에 남는 선분이 경계 4N 개 이하다(안 지우면 한 동 2400 개),
// (2) 동 수 2 배 → 활성 합 ≤ 2.2 배, (3) 상한에 걸린 검사 없음.
test('삼각형 800개 격자 지붕 200동 5000 m: 안쪽 변 상쇄(남는 선분 ≤ 4N), 활성 합 선형, 상한 미도달', () => {
  const N = 20, bs = [];
  for (let k = 0; k < 200; k++) bs.push({ id: k + 1, mesh: grid((k % 15) * 40, Math.floor(k / 15) * 40, N) });
  const run = (list) => { resetStats(); buildBuildingLod(list, 5000); return { ...windingStats }; };
  const half = run(bs.slice(0, 100)), full = run(bs);
  assert.equal(full.calls, 400);
  assert.equal(full.capped, 0);
  assert.ok(full.kept <= 400 * 4 * N, `남은 선분 ${full.kept}`); // 호출당 4N = 80(경계), 합쳐서 400 × 80
  assert.ok(full.active / half.active <= RATIO_MAX, `활성 합 100동 ${half.active}, 200동 ${full.active}`);
  // F-370 검토 #3: 활성 합(기하량)은 스윕·해시가 느려져도 그대로라 따로 센 작업량을 단언한다. 모두 양성 대조(> 0)를 먼저 둔다.
  assert.ok(full.probes > 0 && full.moves > 0 && half.moves > 0 && full.active > 0, '계수가 돌아야 한다');
  assert.ok(full.probes <= PROBE_MULT * full.segs, `상쇄 표 탐사 ${full.probes} > ${PROBE_MULT}·${full.segs}`);
  // 삽입 정렬 이동: 구간마다 예산 8·활성 + 64 를 넘으면 비교 정렬로 넘어가므로 구간당 이동 ≤ 예산 + 활성(넘긴 마지막 한 칸 몫). 구간 수 ≤ 2·남은 선분.
  assert.ok(full.moves <= 9 * full.active + 128 * full.kept, `정렬 이동 ${full.moves}`);
  assert.ok(full.moves / half.moves <= RATIO_MAX, `이동 100동 ${half.moves}, 200동 ${full.moves}`);
  // toFrame 해시: 변 추가 시도마다 탐사 평균 1.5~2.5 칸. 선형 탐색으로 바꾸면 한 동의 선분 수에 비례해 이 상한을 넘는다.
  assert.ok(distStats.addCalls > 0, 'toFrame 이 돌아야 한다');
  assert.ok(distStats.probes >= distStats.addCalls, `조회마다 최소 한 칸을 본다(탐사 계수 누락?): 탐사 ${distStats.probes}, 시도 ${distStats.addCalls}`);
  assert.ok(distStats.probes <= PROBE_MULT * distStats.addCalls, `toFrame 탐사 ${distStats.probes} > ${PROBE_MULT}·${distStats.addCalls}`);
});

// F-370 검토 #3: 동 하나의 크기를 2 배로 할 때(삼각형 수 2 배) 요약·지붕 검사·toFrame 작업이 2.2 배 이하여야 한다. 동 수가 아니라 한 동 안의 이차를 잡는다.
// 길이 L 띠 격자(L×4 칸, 정점을 흔든 것): L=100 → 200 이면 삼각형 800 → 1600. 안 흔들면 공유 변 상쇄·열린 주소 충돌이 단순해져 흔든다.
const strip = (L) => {
  const pos = [], idx = [], W = 4;
  for (let j = 0; j <= W; j++) for (let i = 0; i <= L; i++) pos.push(i + Math.sin(i * 7.1 + j * 3.3) * 0.3, j + Math.cos(i * 2.9 + j * 5.7) * 0.3, 5);
  for (let j = 0; j < W; j++) for (let i = 0; i < L; i++) { const a = j * (L + 1) + i, b = a + 1, c = a + L + 1, d = c + 1; idx.push(a, b, d, a, d, c); }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
};
test('동 하나 크기 2 배(띠 격자 L=100 → 200, 5000 m): 요약·지붕 검사·toFrame 작업이 2.2 배 이하', () => {
  const run = (L) => {
    resetStats();
    // 이웃 한 동을 곁에 둬 병합 경로(toFrame)도 돌게 한다.
    buildBuildingLod([{ id: 1, mesh: strip(L) }, { id: 2, mesh: { ...strip(L), positions: strip(L).positions.map((v, i) => (i % 3 === 1 ? v + 6 : v)) } }], 5000);
    return { w: { ...windingStats }, d: { ...distStats }, s: { ...summarizeStats } };
  };
  const a = run(100), b = run(200);
  assert.ok(a.s.tris > 0 && a.w.active > 0 && a.d.addCalls > 0 && a.d.probes >= a.d.addCalls && a.w.probes > 0, '계수 양성 대조');
  const pairs = [['요약 삼각형', a.s.tris, b.s.tris], ['상쇄 탐사', a.w.probes, b.w.probes], ['활성 합', a.w.active, b.w.active],
    ['toFrame 시도', a.d.addCalls, b.d.addCalls], ['toFrame 탐사', a.d.probes, b.d.probes]];
  for (const [name, x, y] of pairs) assert.ok(y / x <= RATIO_MAX, `${name}: L=100 ${x}, L=200 ${y}`);
  assert.ok(b.w.moves <= 9 * b.w.active + 128 * b.w.kept, `정렬 이동 ${b.w.moves}`);
});
