import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from './index.mjs';

const scene = generate({ seed: 3, count: 30000 });
const cloud = scene.cloud ?? scene;

test('단계 0 은 원본 전부, 단계가 오를수록 점이 줄고 모두 입력의 부분집합', () => {
  const h = buildHierarchy(cloud, { edge0M: 0.4, levelCount: 4, maxLeafPoints: 1024 });
  assert.equal(h.levels[0].count, cloud.count);
  for (let l = 1; l < 4; l++) assert.ok(h.levels[l].count < h.levels[l - 1].count, `level ${l}`);
  for (const lv of h.levels) {
    assert.equal(new Set(lv.indices).size, lv.count);
    assert.ok(lv.indices.every((i) => i < cloud.count));
    assert.equal(lv.leafStart[lv.leafStart.length - 1], lv.count);
    assert.equal(lv.normals.length, 3 * lv.count);
  }
});
test('리프 구간의 점은 그 리프에 속한다', () => {
  const h = buildHierarchy(cloud, { edge0M: 0.4, levelCount: 3, maxLeafPoints: 1024 });
  const lv = h.levels[2], oc = h.octree;
  const leafOf = new Int32Array(cloud.count);
  for (let k = 0; k < oc.leafCount; k++) for (let s = oc.leafStart[k]; s < oc.leafStart[k + 1]; s++) leafOf[oc.order[s]] = k;
  for (let k = 0; k < oc.leafCount; k++) for (let s = lv.leafStart[k]; s < lv.leafStart[k + 1]; s++) assert.equal(leafOf[lv.indices[s]], k);
});

// F-097 ② 확인용: 전역 격자 칸(floor(x/edge))과 팔진 리프의 교집합 조각마다 대표점이 정확히 하나.
function leafOfPoints(oc, n) {
  const leafOf = new Int32Array(n);
  for (let k = 0; k < oc.leafCount; k++) for (let s = oc.leafStart[k]; s < oc.leafStart[k + 1]; s++) leafOf[oc.order[s]] = k;
  return leafOf;
}
function pieceKey(pos, i, edge, leaf) {
  return `${leaf}|${Math.floor(pos[3 * i] / edge)},${Math.floor(pos[3 * i + 1] / edge)},${Math.floor(pos[3 * i + 2] / edge)}`;
}
function assertPiecesHaveOneRep(h, cl) {
  const leafOf = leafOfPoints(h.octree, cl.count), pos = cl.positions;
  for (let l = 1; l < h.levels.length; l++) {
    const lv = h.levels[l], edge = lv.edgeM;
    const repOf = new Map();
    for (let s = 0; s < lv.count; s++) {
      const i = lv.indices[s], key = pieceKey(pos, i, edge, leafOf[i]);
      assert.ok(!repOf.has(key), `level ${l}: 조각 ${key} 에 대표점 둘`);
      repOf.set(key, s);
    }
    let orphan = 0;
    const members = new Map();
    for (let i = 0; i < cl.count; i++) {
      const key = pieceKey(pos, i, edge, leafOf[i]);
      if (!repOf.has(key)) orphan++;
      else { const m = members.get(key) ?? []; m.push(i); members.set(key, m); }
    }
    assert.equal(orphan, 0, `level ${l}: 대표점 없는 리프 조각의 점 수`);
    // 대표 색은 조각 안 점들만의 평균(다른 리프의 점이 섞이지 않음)
    for (const [key, m] of members) {
      const s = repOf.get(key);
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (const i of m) sum += cl.colors[3 * i + ch];
        assert.equal(lv.colors[3 * s + ch], Math.floor((2 * sum + m.length) / (2 * m.length)), `level ${l} ${key} ch ${ch}`);
      }
    }
  }
}
function planeCloud(n, seed) {
  let st = seed >>> 0;
  const rnd = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    positions[3 * i] = 10 * rnd(); positions[3 * i + 1] = 10 * rnd(); positions[3 * i + 2] = 0;
    normals[3 * i] = 0.3 * rnd(); normals[3 * i + 1] = 0.2 * rnd(); normals[3 * i + 2] = 2 + rnd(); // 일부러 비단위
    for (let ch = 0; ch < 3; ch++) colors[3 * i + ch] = Math.floor(256 * rnd());
  }
  return { format: 1, count: n, positions, normals, colors };
}

test('F-097 ②: 10×10 m 평면 4000점 — 모든 단계 l≥1 에서 칸 안 점들의 리프가 하나, 대표점 없는 조각 0', () => {
  const pl = planeCloud(4000, 97);
  const h = buildHierarchy(pl, { edge0M: 0.25, levelCount: 4, maxLeafPoints: 16 });
  assert.ok(h.octree.leafCount > 100);
  assertPiecesHaveOneRep(h, pl);
});
test('F-097 ②: terrain 장면 — 모든 단계 l≥1 에서 칸 안 점들의 리프가 하나', () => {
  const h = buildHierarchy(cloud, { edge0M: 0.4, levelCount: 5, maxLeafPoints: 256 });
  assertPiecesHaveOneRep(h, cloud);
});
test('F-100 ⑧: 단계 0 법선은 단위 길이(길이 0 입력은 (0,0,0) 유지)', () => {
  const pl = planeCloud(500, 8);
  pl.normals.fill(0, 0, 3); // 점 0 은 법선 없음
  const h = buildHierarchy(pl, { edge0M: 0.25, levelCount: 2, maxLeafPoints: 16 });
  const lv = h.levels[0];
  let zero = 0;
  for (let s = 0; s < lv.count; s++) {
    const len = Math.hypot(lv.normals[3 * s], lv.normals[3 * s + 1], lv.normals[3 * s + 2]);
    if (lv.indices[s] === 0) { assert.equal(len, 0); zero++; continue; }
    assert.ok(Math.abs(len - 1) <= 1e-6, `s ${s} len ${len}`);
    const i = lv.indices[s], src = pl.normals, sl = Math.hypot(src[3 * i], src[3 * i + 1], src[3 * i + 2]);
    assert.ok(Math.abs(lv.normals[3 * s + 2] - src[3 * i + 2] / sl) <= 1e-6); // 방향 유지
  }
  assert.equal(zero, 1);
  const t = buildHierarchy(cloud, { edge0M: 0.4, levelCount: 1, maxLeafPoints: 1024 }).levels[0];
  for (let s = 0; s < t.count; s++) {
    const len = Math.hypot(t.normals[3 * s], t.normals[3 * s + 1], t.normals[3 * s + 2]);
    assert.ok(len === 0 || Math.abs(len - 1) <= 1e-6);
  }
});
