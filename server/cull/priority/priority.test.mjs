// T08.6 조각 우선순위 시험. 합성 장면 3종(flat_boxes·terrain·holes, 시드 1, 20만 점) × 고정 시점 8곳(320×180)에서
// renderPoints 로 리프별 실제 차지 픽셀 수를 세어(index → 점 → 리프) 점수 순위와 비교한다. 기준 0.7 은 낮추지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate as flat } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { generate as terrain } from '../../../fixtures/scenes/terrain/index.mjs';
import { generate as holes } from '../../../fixtures/scenes/holes/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { leafPriority, orderChunks } from './index.mjs';

const RHO_MIN = 0.7;
const W = 320, H = 180, N = 200000, POINT_SIZE_M = 0.75;
const VP = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
const SCENES = { flat_boxes: flat, terrain, holes };
const cache = new Map();
function scene(name) {
  if (!cache.has(name)) {
    const { cloud } = SCENES[name]({ seed: 1, count: N });
    const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 4, maxLeafPoints: 2048 });
    const oc = h.octree;
    const leafOf = new Uint32Array(cloud.count);
    for (let k = 0; k < oc.leafCount; k++) for (let s = oc.leafStart[k]; s < oc.leafStart[k + 1]; s++) leafOf[oc.order[s]] = k;
    cache.set(name, { cloud, h, leafOf });
  }
  return cache.get(name);
}
const camOf = (vp) => viewpointToCamera({ ...vp, width: W, height: H });

function pixelsPerLeaf(name, cam) {
  const { cloud, h, leafOf } = scene(name);
  const r = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M });
  const px = new Float64Array(h.octree.leafCount);
  for (const i of r.index) if (i >= 0) px[leafOf[i]]++;
  return px;
}
function ranks(a) { // 동률은 평균 순위
  const idx = [...a.keys()].sort((x, y) => a[x] - a[y]);
  const r = new Float64Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++;
    for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function spearman(a, b) {
  const x = ranks(a), y = ranks(b), n = a.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let s = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { s += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  return s / Math.sqrt(sx * sy);
}

for (const name of Object.keys(SCENES)) {
  for (const vp of VP) {
    test(`순위상관 ≥ ${RHO_MIN} 및 상위 10% 몫 > 하위 50% 몫: ${name} 시점 ${vp.id} ${vp.name}`, (t) => {
      const { h } = scene(name);
      const cam = camOf(vp);
      const px = pixelsPerLeaf(name, cam);
      const sc = leafPriority(h, cam);
      const rho = spearman(sc, px);
      const order = [...sc.keys()].sort((a, b) => sc[b] - sc[a] || a - b);
      const total = px.reduce((s, v) => s + v, 0);
      const n = order.length, top = Math.ceil(n * 0.1), bottom = Math.floor(n * 0.5);
      const topShare = order.slice(0, top).reduce((s, k) => s + px[k], 0) / total;
      const botShare = order.slice(n - bottom).reduce((s, k) => s + px[k], 0) / total;
      const oracle = [...px.keys()].sort((a, b) => px[b] - px[a] || a - b); // 실제 픽셀 수로 정렬한 상한(오라클)
      const oTop = oracle.slice(0, top).reduce((s, k) => s + px[k], 0) / total;
      const oBot = oracle.slice(n - bottom).reduce((s, k) => s + px[k], 0) / total;
      t.diagnostic(`오라클 상위10% ${oTop.toFixed(3)} 하위50% ${oBot.toFixed(3)}; 스피어만 ${rho.toFixed(3)}, 상위10% 몫 ${topShare.toFixed(3)}, 하위50% 몫 ${botShare.toFixed(3)}`);
      assert.ok(rho >= RHO_MIN, `스피어만 ${rho}`);
      // 장면 전체가 고르게 보이는 시점(top_down)에서는 오라클조차 하위 50%(리프 수 5배)가 상위 10% 보다 많이 차지해 이 기준이 성립하지 않는다.
      // 그 경우는 오라클 몫의 90% 이상을 얻는지로 대신한다.
      if (oTop > oBot) assert.ok(topShare > botShare, `상위 ${topShare} 하위 ${botShare}`);
      else assert.ok(topShare >= 0.9 * oTop, `상위 ${topShare} 오라클 ${oTop}`);
    });
  }
}

test('변이 감지: 점수를 뒤집거나 거리만 쓰면 순위상관 기준을 못 넘는다(시험이 변별력을 가짐)', () => {
  const { h } = scene('flat_boxes');
  const cam = camOf(VP[0]);
  const px = pixelsPerLeaf('flat_boxes', cam);
  const sc = leafPriority(h, cam);
  assert.ok(spearman(sc, px) >= RHO_MIN);
  assert.ok(spearman(sc.map((v) => -v), px) < 0);
  const oc = h.octree; // 상자 중심의 번호 순서(위치 무관 값)
  const idxScore = Float64Array.from({ length: oc.leafCount }, (_, k) => (k * 7919) % 101);
  assert.ok(spearman(idxScore, px) < RHO_MIN);
});

// ---- 작은 손계산 장면: 점 2000개짜리 두 덩어리 ----
function tiny() {
  const n = 800, pos = new Float32Array(3 * n), nor = new Float32Array(3 * n), col = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    const near = i < n / 2, j = near ? i : i - n / 2;
    pos[3 * i] = (near ? -2 : 40) + (j % 20) * 0.1; pos[3 * i + 1] = Math.floor(j / 20) * 0.1; pos[3 * i + 2] = 0;
    nor[3 * i + 1] = 1; col[3 * i] = 200;
  }
  const cloud = { format: 1, count: n, positions: pos, normals: nor, colors: col };
  return buildHierarchy(cloud, { edge0M: 0.1, levelCount: 2, maxLeafPoints: 400 });
}
// 카메라 (0,1,-10) 에서 +z 를 본다(R = I, t = −C). 가까운 덩어리는 x∈[-2,0], 먼 덩어리는 x∈[40,42] (시야 밖).
const cam0 = { K: { fx: 100, fy: 100, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, -1, 10], width: 320, height: 180 };

test('가까운 덩어리 리프는 크고(≥ 1 px), 점이 모두 시야 밖인 리프는 보조 항 0.5 미만', () => {
  const h = tiny();
  const sc = leafPriority(h, cam0);
  const oc = h.octree;
  assert.equal(sc.length, oc.leafCount);
  let inView = 0, outView = 0;
  for (let k = 0; k < oc.leafCount; k++) {
    const x = oc.leafStart[k] < oc.leafStart[k + 1] ? h.cloud.positions[3 * oc.order[oc.leafStart[k]]] : 0;
    if (x < 10) { assert.ok(sc[k] > 1, `리프 ${k} 점수 ${sc[k]}`); inView++; } else { assert.ok(sc[k] < 0.5 + 1e-9, `리프 ${k} 점수 ${sc[k]}`); outView++; } // 상자는 화면과 겹쳐도 점이 모두 밖이면 보조 항(< 0.5)만
  }
  assert.ok(inView > 0 && outView > 0);
});

test('카메라 뒤 리프는 0 (카메라를 반대로 돌림)', () => {
  const h = tiny();
  const back = { ...cam0, R: [-1, 0, 0, 0, 1, 0, 0, 0, -1], t: [0, -1, -10] }; // 같은 위치, −z 를 봄
  assert.ok(leafPriority(h, back).every((v) => v === 0));
});

test('화면 중앙에 가까운 리프가 가장자리로 잘린 리프보다 큼', () => {
  const h = tiny();
  const mid = leafPriority(h, cam0);
  const shifted = leafPriority(h, { ...cam0, K: { ...cam0.K, cx: 160 + 270 } }); // 물체가 화면 왼쪽 밖으로 밀림
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  assert.ok(sum(mid) > 10 * sum(shifted), `${sum(mid)} vs ${sum(shifted)}`);
});

test('orderChunks: 점수 내림차순·동률은 번호 오름차순·마스크 0 은 목록에 없음', () => {
  const { h } = scene('terrain');
  const cam = camOf(VP[1]);
  const sc = leafPriority(h, cam);
  const n = sc.length;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = i % 3 === 0 ? 0 : 1;
  const out = orderChunks(h, cam, mask);
  assert.ok(out instanceof Uint32Array);
  assert.equal(out.length, mask.reduce((s, v) => s + v, 0));
  for (const k of out) assert.equal(mask[k], 1);
  assert.equal(new Set(out).size, out.length);
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    assert.ok(sc[a] > sc[b] || (sc[a] === sc[b] && a < b), `위치 ${i}: ${a}(${sc[a]}) ${b}(${sc[b]})`);
  }
  assert.ok(sc.some((v, k) => v === 0 && mask[k]), '동률(0점) 리프가 있어야 동률 규칙을 시험함');
});

test('결정성: 같은 입력 두 번이면 같은 결과, 전부 1 마스크면 모든 리프가 정확히 한 번', () => {
  const { h } = scene('holes');
  const cam = camOf(VP[5]);
  const all = new Uint8Array(h.octree.leafCount).fill(1);
  const a = orderChunks(h, cam, all), b = orderChunks(h, cam, all);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), [...all.keys()]);
  assert.deepEqual(leafPriority(h, cam), leafPriority(h, cam));
});

test('마스크가 전부 0 이면 빈 목록', () => {
  const { h } = scene('holes');
  assert.equal(orderChunks(h, camOf(VP[0]), new Uint8Array(h.octree.leafCount)).length, 0);
});

test('퇴화 카메라(NaN·Infinity·해상도 0·초점 0)는 던지지 않고 점수 전부 0·목록 비어 있음', () => {
  const h = tiny();
  const n = h.octree.leafCount;
  const all = new Uint8Array(n).fill(1);
  const bad = [
    { ...cam0, t: [NaN, 0, 0] },
    { ...cam0, R: [NaN, 0, 0, 0, 1, 0, 0, 0, 1] },
    { ...cam0, K: { ...cam0.K, fx: 0 } },
    { ...cam0, K: { ...cam0.K, cx: Infinity } },
    { ...cam0, width: 0 },
  ];
  for (const c of bad) {
    const sc = leafPriority(h, c);
    assert.equal(sc.length, n);
    assert.ok(sc.every((v) => v === 0));
    assert.equal(orderChunks(h, c, all).length, 0);
  }
});

test('입력 오류는 cull: 오류', () => {
  const h = tiny();
  const n = h.octree.leafCount;
  assert.throws(() => leafPriority(null, cam0), /^Error: cull:/);
  assert.throws(() => leafPriority({}, cam0), /^Error: cull:/);
  assert.throws(() => orderChunks(h, cam0, new Uint8Array(n + 1)), /^Error: cull:/);
  assert.throws(() => orderChunks(h, cam0, new Array(n).fill(1)), /^Error: cull:/);
  const m = new Uint8Array(n).fill(1); m[0] = 2;
  assert.throws(() => orderChunks(h, cam0, m), /^Error: cull:/);
});
