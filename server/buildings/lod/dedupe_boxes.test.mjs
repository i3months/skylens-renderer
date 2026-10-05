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

test('foldContained: L 자 풋프린트는 안에 든 상자를 가린다고 보지 않는다(AABB 만 같아도)', () => {
  const L = prism([[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]], 6);
  const small = prism(rect(12, 12, 18, 18), 3); // L 의 빈 칸 쪽
  const bs = [L, small].map((mesh, id) => ({ id, mesh }));
  Object.assign(foldStats, { calls: 0, input: 0, output: 0 });
  buildBuildingLod(bs, FAR);
  assert.equal(foldStats.output, foldStats.input);
});

test('foldContained: 한 개 이하는 그대로', () => {
  assert.deepEqual(foldContained([]), []);
});
