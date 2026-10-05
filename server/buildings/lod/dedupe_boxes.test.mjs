// F-330 동일·포함 상자 접기 검증. 벽시계가 아니라 접기 뒤 군집 후보 수(foldStats)로 단언한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingLod } from './index.mjs';
import { foldContained, foldStats } from './dedupe_boxes.mjs';
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
  const c = rectItem(0, 0, 20, 20, -1, 6, 2); // 1 m 아래로 나오면 남는다
  assert.equal(foldContained([a, c]).length, 2);
});

test('minZ = i·0.001 인 20×20 상자 2000채는 20 km 에서 1 초 안에 접힌다', () => {
  const n = 2000;
  const bs = [];
  for (let i = 0; i < n; i++) bs.push({ id: i, mesh: lift(prism(rect(0, 0, 20, 20), 5), i * 0.001) });
  reset();
  const t0 = performance.now();
  const out = buildBuildingLod(bs, 20000);
  const ms = performance.now() - t0;
  assert.equal(foldStats.input, n);
  assert.ok(foldStats.output <= 250, `후보 ${foldStats.output}`); // 허용 오차 1 cm 칸마다 한 대표: 접기 없이는 2000
  assert.equal(out.length, 1);
  assert.equal(out[0].ids.length, n);
  assert.ok(ms < 1000, `${ms} ms`);
});

test('foldContained: 한 개 이하는 그대로', () => {
  assert.deepEqual(foldContained([]), []);
});
