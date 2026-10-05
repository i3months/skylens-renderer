// F-330 동일·포함 상자 접기 검증. 벽시계가 아니라 접기 뒤 군집 후보 수(foldStats)로 단언한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingLod, agglomerateStats } from './index.mjs';
import { foldContained, foldStats, FOLD_Z_TOL_M } from './dedupe_boxes.mjs';
import { prism } from './scene.mjs';

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const FAR = 2000;

test('같은 자리 동일 상자 2000채는 후보 1개로 접히고 ids 는 전부 남는다', () => {
  const n = 2000;
  const bs = [];
  for (let i = 0; i < n; i++) bs.push({ id: i, mesh: prism(rect(0, 0, 20, 20), 5) });
  Object.assign(foldStats, { calls: 0, input: 0, output: 0 });
  const out = buildBuildingLod(bs, FAR);
  assert.equal(out.length, 1);
  assert.equal(out[0].ids.length, n);
  assert.deepEqual(out[0].ids, bs.map((b) => b.id));
  assert.equal(out[0].mesh.indices.length / 3, 10); // 상자 하나
  assert.equal(foldStats.calls, 1);
  assert.equal(foldStats.input, n);
  assert.equal(foldStats.output, 1); // 응집 쌍은 0개: 접기 없이는 n(n-1)/2 쌍
});

test('동일 상자를 접은 출력은 한 채만 있을 때와 같은 기하', () => {
  const one = buildBuildingLod([{ id: 0, mesh: prism(rect(0, 0, 20, 20), 5) }], FAR);
  const many = buildBuildingLod([0, 1, 2, 3, 4].map((id) => ({ id, mesh: prism(rect(0, 0, 20, 20), 5) })), FAR);
  assert.deepEqual(Array.from(many[0].mesh.positions), Array.from(one[0].mesh.positions));
  assert.deepEqual(Array.from(many[0].mesh.indices), Array.from(one[0].mesh.indices));
});

test('안에 들어가고 낮은 상자는 접히고 높거나 밖으로 나온 상자는 남는다', () => {
  const big = prism(rect(0, 0, 20, 20), 6);
  const inside = prism(rect(5, 5, 10, 10), 3);
  const taller = prism(rect(5, 5, 10, 10), 12);
  const outside = prism(rect(15, 5, 25, 10), 3);
  const bs = [big, inside, taller, outside].map((mesh, id) => ({ id, mesh }));
  Object.assign(foldStats, { calls: 0, input: 0, output: 0 });
  buildBuildingLod(bs, FAR);
  assert.equal(foldStats.input, 4);
  assert.equal(foldStats.output, 3); // inside 만 접힘
});

const lift = (mesh, dz) => {
  const positions = Float32Array.from(mesh.positions);
  for (let i = 2; i < positions.length; i += 3) positions[i] += dz;
  return { ...mesh, positions };
};
const FAR_L = 10000; // 이 거리에서 L 자도 singleError 를 통과해 접기에 들어간다
const Lring = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]];
const reset = () => Object.assign(foldStats, { calls: 0, input: 0, output: 0 });

test('foldContained: L 자 풋프린트는 AABB 만 같은 상자를 가린다고 보지 않는다', () => {
  const L = prism(Lring, 6);
  const small = prism(rect(12, 12, 18, 18), 3); // L 의 빈 칸 쪽
  const bs = [L, small].map((mesh, id) => ({ id, mesh }));
  reset();
  const out = buildBuildingLod(bs, FAR_L);
  assert.ok(foldStats.input >= 2, `접기에 둘 다 들어가야 한다: ${foldStats.input}`);
  assert.equal(foldStats.output, foldStats.input);
  // 접기를 끈 기대 출력: 둘 다 후보로 남아 응집된 결과(삼각형 20). L 의 AABB 로 접으면 10 으로 줄어 빈 칸 상자가 사라진다.
  assert.deepEqual(out.flatMap((g) => g.ids).sort(), [0, 1]);
  assert.equal(out.reduce((n, g) => n + g.mesh.indices.length / 3, 0), 20);
});

// foldContained 직접 시험용 최소 항목.
function rectItem(x0, y0, x1, y1, z0, z1, order, fill) {
  const f = fill ?? [x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1];
  return { order, it: { mesh: { indices: new Array(30).fill(0) } }, minX: x0, minY: y0, maxX: x1, maxY: y1, minZ: z0, maxZ: z1, fill: f };
}

test('foldContained: 직사각형 대표는 풋프린트가 다른 상자도 가린다', () => {
  const big = rectItem(0, 0, 20, 20, 0, 6, 0);
  const lTri = [0, 0, 6, 0, 6, 3, 0, 0, 6, 3, 3, 3, 0, 0, 3, 3, 3, 6];
  const odd = rectItem(4, 4, 10, 10, 0, 3, 1, lTri); // 대표와 풋프린트가 다름
  const out = foldContained([big, odd]);
  assert.equal(out.length, 1);
  assert.equal(out[0], big);
});

test('foldContained: 직사각형이 아닌 대표는 풋프린트가 다른 상자를 가리지 못한다', () => {
  const lTri = [0, 0, 20, 0, 20, 8, 0, 0, 20, 8, 8, 8, 0, 0, 8, 8, 8, 20, 0, 0, 8, 20, 0, 20];
  const L = rectItem(0, 0, 20, 20, 0, 6, 0, lTri);
  const small = rectItem(12, 12, 18, 18, 0, 3, 1);
  assert.equal(foldContained([L, small]).length, 2);
  const same = rectItem(0, 0, 20, 20, 0, 3, 2, lTri.slice());
  assert.equal(foldContained([L, same]).length, 1); // 같은 풋프린트는 가림
});

test('foldContained: minZ 가 mm 만 다른 상자도 접힌다', () => {
  const a = rectItem(0, 0, 20, 20, 0.001, 6, 0);
  const b = rectItem(0, 0, 20, 20, 0, 6, 1);
  assert.equal(foldContained([a, b]).length, 1);
  const c = rectItem(0, 0, 20, 20, -0.03, 6, 2); // 3 cm 아래로 나오면 남는다(허용 1 cm 초과)
  assert.equal(foldContained([a, c]).length, 2);
  const d = rectItem(0, 0, 20, 20, -0.02, 6, 3);
  assert.equal(foldContained([a, d]).length, 2);
  assert.equal(FOLD_Z_TOL_M, 0.01);
});

test('foldContained: maxZ 가 mm 만 높으면 접히고 cm 넘게 높으면 남는다', () => {
  const rep = rectItem(0, 0, 20, 20, 0, 6, 0);
  assert.equal(foldContained([rep, rectItem(5, 5, 10, 10, 0, 6.004, 1)]).length, 1); // 안쪽 상자가 4 mm 더 높아도 접힘
  // 6.03 은 대표(6)보다 높아 정렬상 먼저 대표가 되므로, 대표 쪽을 낮게 둔 쌍으로 확인한다: 안쪽 상자가 3 cm 더 높다.
  const low = rectItem(0, 0, 20, 20, 0, 6, 0);
  const tall = rectItem(5, 5, 10, 10, 0, 6.03, 1);
  assert.equal(foldContained([low, tall]).length, 2);
  const tall2 = rectItem(5, 5, 10, 10, 0, 6.02, 1);
  assert.equal(foldContained([low, tall2]).length, 2);
});

// 접기 전 구현(대표 전부 선형 비교)과 같은 결과인가: 무작위 입력 여러 시드.
function foldLinear(singles) {
  const area = (m) => (m.maxX - m.minX) * (m.maxY - m.minY);
  const sorted = singles.slice().sort((p, q) => area(q) - area(p) || q.maxZ - p.maxZ || p.order - q.order);
  const reps = [];
  const dropped = new Set();
  const isR = (m) => { const f = m.fill; for (let o = 0; o < f.length; o += 2) { if (Math.abs(f[o] - m.minX) > 1e-9 && Math.abs(f[o] - m.maxX) > 1e-9) return false; if (Math.abs(f[o + 1] - m.minY) > 1e-9 && Math.abs(f[o + 1] - m.maxY) > 1e-9) return false; } return f.length > 0; };
  const sameF = (a, b) => a.fill.length === b.fill.length && a.fill.every((v, i) => Math.abs(v - b.fill[i]) <= 1e-9);
  const cov = (a, b) => !(b.minX < a.minX - 1e-9 || b.maxX > a.maxX + 1e-9 || b.minY < a.minY - 1e-9 || b.maxY > a.maxY + 1e-9 ||
    b.maxZ > a.maxZ + 0.01 || b.minZ < a.minZ - 0.01) && (isR(a) || sameF(a, b));
  for (const m of sorted) {
    let hidden = false;
    for (const r of reps) if (cov(r, m)) { hidden = true; break; }
    if (hidden) dropped.add(m); else if (m.it.mesh.indices.length / 3 >= 10) reps.push(m);
  }
  return singles.filter((m) => !dropped.has(m));
}

test('foldContained: 무작위 입력 20 시드에서 선형 비교 구현과 접기 결과가 같다', () => {
  for (let seed = 1; seed <= 20; seed++) {
    let st = seed * 2654435761 >>> 0;
    const rnd = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
    const mk = () => {
      const items = [];
      const n = 150 + Math.floor(rnd() * 100);
      for (let i = 0; i < n; i++) {
        const x0 = Math.floor(rnd() * 4) * 2, y0 = Math.floor(rnd() * 4) * 2;
        const w = 2 + Math.floor(rnd() * 3) * 2, h = 2 + Math.floor(rnd() * 3) * 2;
        const z0 = Math.floor(rnd() * 3) * 0.005 + (rnd() < 0.3 ? Math.floor(rnd() * 5) * 0.01 : 0);
        const z1 = z0 + 3 + Math.floor(rnd() * 3) * 0.004 + (rnd() < 0.2 ? 2 : 0);
        const it = rectItem(x0, y0, x0 + w, y0 + h, z0, z1, i);
        if (rnd() < 0.15) it.fill = [x0, y0, x0 + w, y0, x0, y0 + h]; // 직사각형이 아닌 풋프린트
        if (rnd() < 0.1) it.it.mesh.indices = new Array(12).fill(0); // 대표가 될 수 없음
        items.push(it);
      }
      return items;
    };
    const a = mk();
    const copy = a.map((m) => ({ ...m, it: m.it }));
    const got = foldContained(a).map((m) => m.order);
    const want = foldLinear(copy).map((m) => m.order);
    assert.deepEqual(got, want, `seed ${seed}`);
    assert.ok(want.length < copy.length, `seed ${seed}: 접기가 일어나야 한다`);
  }
});

// F-370: 벽시계 대신 작업량 계수로 판정한다(병렬 부하에 영향받지 않는다). foldStats.covers 는 covers() 호출 수다.
// 비율 기준 RATIO_MAX: 입력 2 배일 때 선형 작업은 2.0 배, 이차는 4.0 배. 2.2 = 선형 + 10 % 여유로, 측정값에 맞춘 값이 아니라 두 극 사이에서 정했다.
// 절대 상한: 입력 하나가 비교하는 대표는 minZ 가 ±FOLD_Z_TOL_M 안인 것뿐이라 step 간격에서 (2·TOL/step + 2) 개 이하다
// (선형 비교였다면 대표 전부: step 0.02 에서 n=2000 은 약 200 만 회, 이 상한은 6000 회).
// 참고(시험이 보지 않는 측정, Node 22 4코어): 색인 이전 선형 접기 단독은 n=2000·step 0.02 에서 약 25 ms, n=4000 에서 약 96 ms 였다.
// F-367 에 적힌 2.3~2.5 s 는 접기가 아니라 접기가 없던 때의 buildBuildingLod 전체(응집 쌍 n²)였다.
const RATIO_MAX = 2.2;
const stepCase = (n, step) => {
  const items = [];
  for (let i = 0; i < n; i++) items.push(rectItem(0, 0, 20, 20, i * step, 5 + i * step, i));
  Object.assign(foldStats, { calls: 0, input: 0, output: 0, covers: 0 });
  const out = foldContained(items);
  return { covers: foldStats.covers, output: out.length };
};

for (const step of [0.001, 0.01, 0.02, 0.1]) {
  test(`minZ = i·${step} 인 20×20 상자 n=2000·4000: covers 호출 수가 z 허용 안 대표 수 이하이고 n 에 선형`, () => {
    const a = stepCase(2000, step), b = stepCase(4000, step);
    if (step === 0.001) assert.ok(a.output <= 250, `후보 ${a.output}`); // 허용 오차 1 cm 칸마다 한 대표
    if (step >= 0.02) { assert.equal(a.output, 2000); assert.equal(b.output, 4000); } // 1 cm 넘게 벌어지면 하나도 접히지 않는다
    for (const [n, r] of [[2000, a], [4000, b]]) {
      const bound = (2 * FOLD_Z_TOL_M / step + 2) * n;
      assert.ok(r.covers <= bound, `n=${n}: covers ${r.covers} > ${bound}`);
    }
    if (a.covers > 0) assert.ok(b.covers / a.covers <= RATIO_MAX, `covers n=2000 ${a.covers}, n=4000 ${b.covers}`);
  });
}

// F-367: 접기가 안 되는 입력(step 0.02, 1 cm 넘게 벌어짐)은 응집 단계가 전쌍 n²/2 쌍을 만들던 곳이다. 지금은 mayMerge 후보만 훑는다.
// 계수 agglomerateStats.visited: 응집 색인 조회가 훑은 군집 수(전쌍이면 n=4000 에서 약 800 만).
// 결과는 색인 이전과 같다: 대표 수 n/25 개 상자(높이 간격 hideTol 0.485 m 안의 25 채씩).
for (const step of [0.02, 0.05]) {
  test(`buildBuildingLod: 같은 자리 상자 step ${step} 에서 응집 조회 수가 n 에 선형(n=4000 → 8000 ≤ 2.2 배)이고 n²/2 보다 훨씬 작다`, () => {
    const run = (n) => {
      const bs = [];
      for (let i = 0; i < n; i++) bs.push({ id: i, mesh: lift(prism(rect(0, 0, 20, 20), 5), i * step) });
      Object.assign(agglomerateStats, { calls: 0, clusters: 0, visited: 0 });
      const out = buildBuildingLod(bs, FAR);
      return { visited: agglomerateStats.visited, ids: out.flatMap((g) => g.ids).length, tris: out.reduce((t, g) => t + g.mesh.indices.length / 3, 0), n };
    };
    const a = run(4000), b = run(8000);
    for (const r of [a, b]) {
      assert.equal(r.ids, r.n);
      assert.ok(r.visited <= r.n * r.n / 16, `n=${r.n}: 조회 ${r.visited}`); // 전쌍의 1/8 이하(n²/2 의 1/8)
    }
    if (step === 0.02) { assert.equal(a.tris, 1600); assert.equal(b.tris, 3200); } // n/25 개 상자 × 10 삼각형
    assert.ok(b.visited / a.visited <= RATIO_MAX, `조회 n=4000 ${a.visited}, n=8000 ${b.visited}`);
  });
}

test('foldContained: 한 개 이하는 그대로', () => {
  assert.deepEqual(foldContained([]), []);
});
