// T07.9 점진 순서 시험. 파라미터는 모두 리터럴이다.
// 해상도를 320x180 으로 줄였다(원 시점은 1280x720): 참조 래스터라이저(CPU)로 시점 8곳 x k 5개를 돌리는 시간을 줄이려는 것.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { buildHierarchy } from '../hierarchy/index.mjs';
import { buildDistanceTable, levelForDistance } from '../distance_table/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { ssim } from '../../metrics/ssim/index.mjs';
import { progressiveChunks, applyChunks } from './index.mjs';

const W = 320, H = 180, POINT_SIZE_M = 0.6, TAU = 1, LEVELS = 4;
const vps = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url))).viewpoints;
const scene = generate({ seed: 7, count: 60000 });
const cloud = scene.cloud ?? scene;
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: LEVELS, maxLeafPoints: 1024 });
const camOf = (vp) => viewpointToCamera({ ...vp, width: W, height: H });
const chunksOf = (cam) => progressiveChunks(h, cam, { thresholdPx: TAU });

// 리프별로 조각을 모은다
function byLeaf(chunks) {
  const m = new Map();
  for (const c of chunks) { if (!m.has(c.leaf)) m.set(c.leaf, []); m.get(c.leaf).push(c); }
  return m;
}
// 점이 화면 안에 투영되는가
function pointInView(cam, i) {
  const { R, t, K } = cam;
  const x = cloud.positions[3 * i], y = cloud.positions[3 * i + 1], z = cloud.positions[3 * i + 2];
  const zc = R[6] * x + R[7] * y + R[8] * z + t[2];
  if (!(zc > 0)) return false;
  const u = K.fx * (R[0] * x + R[1] * y + R[2] * z + t[0]) / zc + K.cx;
  const v = K.fy * (R[3] * x + R[4] * y + R[5] * z + t[1]) / zc + K.cy;
  return u >= 0 && u < W && v >= 0 && v < H;
}

test('조각 순서: 거친 단계 먼저, 한 리프는 최대 2개(교체열)이고 중간 단계는 건너뜀', () => {
  for (const vp of vps) {
    const ch = chunksOf(camOf(vp));
    assert.ok(ch.length > 0, `시점 ${vp.id}`);
    for (let i = 1; i < ch.length; i++) assert.ok(ch[i - 1].level >= ch[i].level, `시점 ${vp.id}: 단계 내림차순`);
    for (const [leaf, list] of byLeaf(ch)) {
      assert.ok(list.length <= 2, `리프 ${leaf}`);
      // 첫 조각은 최대 단계. 단, 그 리프에 최대 단계 대표점이 하나도 없으면(칸 대표점이 이웃 리프에 속함) 목표 조각 하나뿐이다.
      const emptyCoarse = h.levels[LEVELS - 1].leafStart[leaf + 1] === h.levels[LEVELS - 1].leafStart[leaf];
      if (!emptyCoarse) assert.equal(list[0].level, LEVELS - 1, '첫 조각은 최대 단계');
      if (list.length === 2) { assert.ok(list[1].level < LEVELS - 1); assert.ok(ch.indexOf(list[0]) < ch.indexOf(list[1])); }
    }
  }
});

test('같은 단계 안에서는 카메라에 가까운 리프 먼저', () => {
  const cam = camOf(vps[0]);
  const ch = chunksOf(cam);
  const { R, t } = cam;
  const C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  const node = new Map();
  for (let n = 0; n < h.octree.nodeCount; n++) if (h.octree.leafIndex[n] >= 0) node.set(h.octree.leafIndex[n], n);
  const dist = (leaf) => {
    const n = node.get(leaf); let s = 0;
    for (let a = 0; a < 3; a++) {
      const lo = h.octree.boxMin[3 * n + a], hi = h.octree.boxMax[3 * n + a];
      const d = C[a] < lo ? lo - C[a] : C[a] > hi ? C[a] - hi : 0; s += d * d;
    }
    return Math.sqrt(s);
  };
  for (let i = 1; i < ch.length; i++) if (ch[i - 1].level === ch[i].level) assert.ok(dist(ch[i - 1].leaf) <= dist(ch[i].leaf) + 1e-9);
  // 목표 단계는 거리표와 일치: 목표(마지막 조각 단계)는 거리가 멀수록 작아지지 않는다
  const table = buildDistanceTable({ fx: cam.K.fx, thresholdPx: TAU, edge0M: h.edge0M, levelCount: LEVELS });
  for (const [leaf, list] of byLeaf(ch)) {
    const T = list[list.length - 1].level;
    assert.equal(T, Math.min(LEVELS - 1, levelForDistance(table, Math.max(dist(leaf), 1e-9))), `리프 ${leaf} 목표 단계`);
  }
});

test('100% 적용 = 선택된 목표 단계 점군과 점 단위로 동일, 모든 k 에서 중복 없음(교체)', () => {
  for (const vp of vps) {
    const cam = camOf(vp);
    const ch = chunksOf(cam);
    const full = applyChunks(h, ch, ch.length);
    // 기대값: 리프마다 목표 단계(그 리프의 가장 낮은 단계 조각)의 구간을 리프 오름차순으로
    const target = new Map();
    for (const [leaf, list] of byLeaf(ch)) target.set(leaf, list[list.length - 1].level);
    const pos = [], col = [], nrm = [];
    for (const leaf of [...target.keys()].sort((a, b) => a - b)) {
      const lv = h.levels[target.get(leaf)];
      for (let s = lv.leafStart[leaf]; s < lv.leafStart[leaf + 1]; s++) {
        const i = lv.indices[s];
        pos.push(...cloud.positions.subarray(3 * i, 3 * i + 3));
        nrm.push(...lv.normals.subarray(3 * s, 3 * s + 3));
        col.push(...lv.colors.subarray(3 * s, 3 * s + 3));
      }
    }
    assert.equal(full.count, pos.length / 3);
    assert.deepEqual(Array.from(full.positions), pos);
    assert.deepEqual(Array.from(full.normals), nrm);
    assert.deepEqual(Array.from(full.colors), col);
    // 중복 없음: 모든 k 에서 점 수 = 리프별 현재 단계 점 수의 합(= 누적이면 더 큼), 위치 중복 없음
    for (const p of [10, 25, 50, 75, 100]) {
      const k = Math.ceil((ch.length * p) / 100);
      const part = applyChunks(h, ch, k);
      const cur = new Map();
      for (let i = 0; i < k; i++) cur.set(ch[i].leaf, ch[i].indices.length);
      assert.equal(part.count, [...cur.values()].reduce((a, b) => a + b, 0));
      assert.equal(new Set(Array.from({ length: part.count }, (_, i) => `${part.positions[3 * i]},${part.positions[3 * i + 1]},${part.positions[3 * i + 2]}`)).size, part.count);
    }
  }
});

test('시야 밖 리프 조각 0: 완전 후방 카메라는 조각 없음, 조각 없는 리프에는 화면 안 점이 없다', () => {
  for (const vp of vps) {
    const cam = camOf(vp);
    const has = new Set(chunksOf(cam).map((c) => c.leaf));
    const { leafStart, order } = h.octree;
    for (let k = 0; k < h.octree.leafCount; k++) {
      if (has.has(k)) continue;
      for (let s = leafStart[k]; s < leafStart[k + 1]; s++) assert.ok(!pointInView(cam, order[s]), `시점 ${vp.id} 리프 ${k} 에 화면 안 점`);
    }
  }
  // 시점 3(내려다봄)을 180도 뒤집어(R -> diag(-1,1,-1)·R, 눈 위치 유지) 땅 반대편 하늘을 보게 한다
  const cam = camOf(vps[2]);
  const f = [-1, 1, -1];
  const R = cam.R.map((v, i) => f[Math.floor(i / 3)] * v);
  const t = cam.t.map((v, i) => f[i] * v);
  assert.equal(chunksOf({ ...cam, R, t }).length, 0);
});

test('점진 SSIM(원본 대비): k=10,25,50,75,100% 에서 단조 비감소(허용 오차 0)', () => {
  const rows = [];
  for (const vp of vps) {
    const cam = camOf(vp);
    const ch = chunksOf(cam);
    const ref = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M });
    const s = [10, 25, 50, 75, 100].map((p) => {
      const r = renderPoints(cam, applyChunks(h, ch, Math.ceil((ch.length * p) / 100)), { pointSizeM: POINT_SIZE_M });
      return ssim(ref.color, r.color, W, H, 3);
    });
    rows.push(`시점 ${vp.id}: ${s.map((v) => v.toFixed(4)).join(' ')}`);
    for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i - 1], `시점 ${vp.id}: k 증가에 SSIM 감소 ${s[i - 1]} -> ${s[i]}`);
  }
  console.log(`# SSIM k=10,25,50,75,100\n# ${rows.join('\n# ')}`);
});

test('음성: 누적 적용(교체 아님)은 중복을 만들고, 잘못된 입력은 명시 오류', () => {
  const cam = camOf(vps[3]);
  const ch = chunksOf(cam);
  // 목표 단계가 최대 단계가 아닌 리프를 찾아 두 조각을 모두 "누적"하면 같은 점이 두 단계에서 나타난다
  const two = [...byLeaf(ch).values()].find((l) => l.length === 2);
  assert.ok(two, '교체열을 가진 리프가 있어야 함');
  const idxA = new Set(two[0].indices);
  assert.ok(two[1].indices.some((i) => idxA.has(i)), '두 단계 대표점은 겹침(누적하면 중복)');
  const replaced = applyChunks(h, two, 2);
  assert.equal(replaced.count, two[1].indices.length);
  assert.throws(() => applyChunks(h, ch, -1), /lod:/);
  assert.throws(() => applyChunks(h, ch, ch.length + 1), /lod:/);
  assert.throws(() => applyChunks(h, ch, 1.5), /lod:/);
  assert.throws(() => applyChunks(h, [{ level: 9, leaf: 0, indices: new Uint32Array(0) }], 1), /lod:/);
  assert.throws(() => applyChunks(h, [{ level: 0, leaf: 99999, indices: new Uint32Array(0) }], 1), /lod:/);
  const bad = { ...ch[0], indices: ch[0].indices.slice(1) };
  assert.throws(() => applyChunks(h, [bad], 1), /lod:/);
  assert.throws(() => progressiveChunks(h, cam, { thresholdPx: 0 }), /lod:/);
  assert.throws(() => progressiveChunks(null, cam, { thresholdPx: 1 }), /lod:/);
});
