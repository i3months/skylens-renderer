// materialize / applyChunks 색인 산술 복사 구현이 이전(점마다 subarray+set) 구현과 바이트 동일한지 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { buildHierarchy } from '../hierarchy/index.mjs';
import { progressiveChunks, applyChunks } from '../progressive/index.mjs';
import { selectWithBudget } from '../budget/index.mjs';
import { materialize, selectLevels } from './index.mjs';

const { cloud } = generate({ seed: 3, count: 40000 });
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 4, maxLeafPoints: 512 });

function refCopy(items) {
  const n = items.length;
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
  items.forEach(({ lv, s, i }, o) => {
    positions.set(cloud.positions.subarray(3 * i, 3 * i + 3), 3 * o);
    normals.set(lv.normals.subarray(3 * s, 3 * s + 3), 3 * o);
    colors.set(lv.colors.subarray(3 * s, 3 * s + 3), 3 * o);
  });
  return { format: 1, count: n, positions, normals, colors };
}
const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function assertSame(a, b) {
  assert.equal(a.format, b.format);
  assert.equal(a.count, b.count);
  for (const f of ['positions', 'normals', 'colors']) {
    assert.equal(a[f].constructor, b[f].constructor);
    assert.ok(bytes(a[f]).equals(bytes(b[f])), f);
  }
}

test('materialize: 이전 구현과 바이트 동일(단계 섞임·NOT_DRAWN 포함)', () => {
  const leafLevel = new Uint8Array(h.octree.leafCount);
  let seed = 12345, pointCount = 0;
  const items = [];
  for (let k = 0; k < leafLevel.length; k++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const r = (seed >>> 16) % 6;
    leafLevel[k] = r === 5 ? NOT_DRAWN : r % h.levels.length;
    if (leafLevel[k] === NOT_DRAWN) continue;
    const lv = h.levels[leafLevel[k]];
    for (let s = lv.leafStart[k]; s < lv.leafStart[k + 1]; s++) items.push({ lv, s, i: lv.indices[s] });
    pointCount += lv.leafStart[k + 1] - lv.leafStart[k];
  }
  assert.ok(pointCount > 0);
  assertSame(materialize(h, { leafLevel, pointCount }), refCopy(items));
});

test('applyChunks: 이전 구현과 바이트 동일(앞 k 개마다)', () => {
  const cam = { K: { fx: 400, fy: 400, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 60], width: 320, height: 180 };
  let chunks = progressiveChunks(h, cam, { thresholdPx: 1 });
  if (chunks.length === 0) chunks = progressiveChunks(h, { ...cam, t: [0, 0, 0] }, { thresholdPx: 1 });
  assert.ok(chunks.length > 0);
  for (const k of [0, 1, Math.floor(chunks.length / 2), chunks.length]) {
    const cur = new Map();
    for (let i = 0; i < k; i++) cur.set(chunks[i].leaf, chunks[i]);
    const items = [];
    for (const leaf of [...cur.keys()].sort((a, b) => a - b)) {
      const c = cur.get(leaf), lv = h.levels[c.level], s0 = lv.leafStart[leaf];
      for (let j = 0; j < c.indices.length; j++) items.push({ lv, s: s0 + j, i: c.indices[j] });
    }
    assertSame(applyChunks(h, chunks, k), refCopy(items));
  }
});

test('levels[l].positions = indices 순서로 모은 입력 위치(바이트 동일, 대표점당 12 B)', () => {
  for (const lv of h.levels) {
    assert.ok(lv.positions instanceof Float32Array);
    assert.equal(lv.positions.length, 3 * lv.count);
    const ref = new Float32Array(3 * lv.count);
    for (let s = 0; s < lv.count; s++) ref.set(cloud.positions.subarray(3 * lv.indices[s], 3 * lv.indices[s] + 3), 3 * s);
    assert.ok(bytes(lv.positions).equals(bytes(ref)), `단계 ${lv.level}`);
  }
});

test('materialize: levels[l].positions 가 없거나 길이가 틀린 계층은 lod: 오류', () => {
  const sel = { leafLevel: new Uint8Array(h.octree.leafCount), pointCount: h.cloud.count };
  const without = { ...h, levels: h.levels.map((lv, l) => (l === 1 ? { ...lv, positions: undefined } : lv)) };
  assert.throws(() => materialize(without, sel), /^Error: lod:/);
  const short = { ...h, levels: h.levels.map((lv, l) => (l === 2 ? { ...lv, positions: lv.positions.subarray(3) } : lv)) };
  assert.throws(() => materialize(short, sel), /^Error: lod:/);
});

// F-104 ④: 점 0개 리프는 select 도 budget(·progressive) 처럼 NOT_DRAWN 으로 통일한다.
// 팔진 트리는 빈 자식을 만들지 않으므로 빈 리프는 점 0개 점군의 루트뿐이다. 카메라는 그 루트 상자(원점 중심 한 변 1 m)를 정면에서 본다.
test('점 0개 리프: selectLevels 와 selectWithBudget 이 모두 NOT_DRAWN', () => {
  const empty = { format: 1, count: 0, positions: new Float32Array(0), normals: new Float32Array(0), colors: new Uint8Array(0) };
  const he = buildHierarchy(empty, { edge0M: 0.5, levelCount: 3 });
  assert.equal(he.octree.leafCount, 1);
  assert.equal(he.levels[0].leafStart[1] - he.levels[0].leafStart[0], 0);
  const cam = { K: { fx: 400, fy: 400, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 5], width: 320, height: 180 };
  const sel = selectLevels(he, cam, { thresholdPx: 1 });
  const bud = selectWithBudget(he, cam, { thresholdPx: 1, budgetPoints: 10 });
  assert.deepEqual([...sel.leafLevel], [NOT_DRAWN]);
  assert.deepEqual([...bud.leafLevel], [...sel.leafLevel]);
  assert.equal(sel.pointCount, 0);
  assert.equal(materialize(he, sel).count, 0);
  assert.equal(progressiveChunks(he, cam, { thresholdPx: 1 }).length, 0);
});
