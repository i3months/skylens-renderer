// F-107 ③④: applyChunks 의 점 번호 대조 순서와 위치 출처 시험. 파라미터는 모두 리터럴이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/holes/index.mjs';
import { buildHierarchy } from '../hierarchy/index.mjs';
import { materialize } from '../select/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { progressiveChunks, applyChunks } from './index.mjs';

const s = generate({ seed: 1, count: 20000 });
const hier = buildHierarchy(s.cloud, { edge0M: 0.5, levelCount: 4, maxLeafPoints: 512 });
const cam = { width: 220, height: 220, K: { fx: 200, fy: 200, cx: 110, cy: 110 }, R: [1, 0, 0, 0, 0, 1, 0, -1, 0], t: [0, 0, 200] };
const ch = progressiveChunks(hier, cam, { thresholdPx: 2 });
const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

test('F-107 ③: 건너뛸 조각(추월당한 거친 조각)의 틀린 점 번호도 도착 순서와 무관하게 lod: 오류', () => {
  // 거친 조각 + 고운 조각이 둘 다 있는 리프를 찾는다.
  const byLeaf = new Map();
  for (const c of ch) { if (!byLeaf.has(c.leaf)) byLeaf.set(c.leaf, []); byLeaf.get(c.leaf).push(c); }
  const pair = [...byLeaf.values()].find((l) => l.length === 2);
  assert.ok(pair, '거친+고운 조각 쌍이 있는 리프');
  const [coarse, fine] = pair;
  const bad = new Uint32Array(coarse.indices);
  bad[0] = bad[0] + 1; // 개수는 같고 대표점 번호만 틀리다
  const badCoarse = { ...coarse, indices: bad };
  assert.throws(() => applyChunks(hier, [badCoarse, fine], 2), /lod:.*점 번호/, '거친 조각이 먼저');
  assert.throws(() => applyChunks(hier, [fine, badCoarse], 2), /lod:.*점 번호/, '고운 조각이 먼저(거친 조각은 건너뛰는 자리)');
});

test('F-107 ④: applyChunks 와 materialize 는 같은 출처(levels[l].positions)라 바이트 동일', () => {
  const a = applyChunks(hier, ch, ch.length);
  const leafLevel = new Uint8Array(hier.octree.leafCount).fill(NOT_DRAWN);
  for (const c of ch) leafLevel[c.leaf] = Math.min(leafLevel[c.leaf], c.level); // 가장 고운 조각 단계(NOT_DRAWN=255 가 최대)
  const m = materialize(hier, { leafLevel, pointCount: a.count });
  assert.ok(a.count > 0);
  assert.equal(m.count, a.count);
  for (const f of ['positions', 'normals', 'colors']) assert.ok(bytes(a[f]).equals(bytes(m[f])), f);
});

test('F-107 ④: applyChunks 는 cloud.positions 를 읽지 않는다(만든 뒤 cloud 가 바뀌어도 결과 불변)', () => {
  const before = applyChunks(hier, ch, ch.length);
  const saved = s.cloud.positions;
  s.cloud.positions = new Float32Array(saved.length).fill(12345.5);
  try {
    const after = applyChunks(hier, ch, ch.length);
    assert.ok(bytes(before.positions).equals(bytes(after.positions)));
  } finally { s.cloud.positions = saved; }
});
