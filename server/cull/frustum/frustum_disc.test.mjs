// F-116: 절두체 컬링은 점 원판 반경 r = fx·sizeM/(2d) 만큼 좌·우·위·아래 평면을 바깥으로 밀어야 한다.
// 참조 래스터(server/raster_ref/zbuffer)가 실제로 그린 점(index ≥ 0)의 리프는 하나도 제거되면 안 된다(거짓 제거 0).
// 수치는 모두 고정 시드로 미리 구워 둔 값이다(사후 문턱 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { boxMayBeVisibleSplat } from '../../lod/select/view_check.mjs';
import { frustumCull } from './index.mjs';

const W = 960, H = 540;
const CAM = { width: W, height: H, K: { fx: 754.32, fy: 753.85, cx: 480, cy: 270 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const SIZE_M = 0.05; // r = 754.32·0.05/2 = 18.858 px (깊이 1 m)

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cloudOf(pts) {
  const n = pts.length / 3;
  return { format: 1, count: n, positions: Float32Array.from(pts), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) };
}

// 깊이 d 에서 픽셀 (u, v) 로 투영되는 점(R = I, t = 0)
const unproject = (u, v, d) => [((u - CAM.K.cx) * d) / CAM.K.fx, ((v - CAM.K.cy) * d) / CAM.K.fy, d];

// 화면 가장자리 바깥 0~r px 에 점을 뿌린 장면. 리프마다 점 1~4 개를 한 가장자리 바깥에 비슷한 깊이로 모으고,
// 리프 상자는 그 점들의 꼭 맞는 AABB(가장 엄격한 경우; octree 칸 상자는 이보다 크므로 더 쉽게 남는다).
// 점은 깊이 1~8 m, 바깥 거리는 그 깊이 원판 반경 r(fx 로 잼, 위·아래도 같음)의 0~1 배.
// 리프의 20% 는 미끼(바깥 거리 5r~10r)라 제거가 실제로 일어난다.
function edgeScene(seed, leafCount, cam = CAM) {
  const r = rng(seed), pts = [], leafStart = [0];
  for (let k = 0; k < leafCount; k++) {
    const decoy = r() < 0.2;
    const side = Math.floor(r() * 4);
    const d0 = 1 + 7 * r(), along0 = r();
    const m = 1 + Math.floor(r() * 4);
    for (let j = 0; j < m; j++) {
      const d = d0 * (1 + 0.05 * r());
      const rad = (cam.K.fx * SIZE_M) / (2 * d);
      const off = decoy ? rad * (5 + 5 * r()) : rad * r();
      const along = Math.min(1, along0 + 0.02 * r());
      let u, v;
      if (side === 0) { u = -off; v = along * H; }
      else if (side === 1) { u = W + off; v = along * H; }
      else if (side === 2) { u = along * W; v = -off; }
      else { u = along * W; v = H + off; }
      pts.push(...unproject(u, v, d));
    }
    leafStart.push(pts.length / 3);
  }
  return { cloud: cloudOf(pts), leafStart: Uint32Array.from(leafStart) };
}

// 리프 = 노드인 최소 계층. 리프 k 의 점은 [leafStart[k], leafStart[k+1]), 상자는 그 점들의 AABB.
function tightHierarchy(cloud, leafStart) {
  const n = leafStart.length - 1, pos = cloud.positions;
  const boxMin = new Float32Array(3 * n).fill(Infinity), boxMax = new Float32Array(3 * n).fill(-Infinity);
  for (let k = 0; k < n; k++) for (let i = leafStart[k]; i < leafStart[k + 1]; i++) for (let a = 0; a < 3; a++) {
    boxMin[3 * k + a] = Math.min(boxMin[3 * k + a], pos[3 * i + a]);
    boxMax[3 * k + a] = Math.max(boxMax[3 * k + a], pos[3 * i + a]);
  }
  return {
    octree: { nodeCount: n, leafCount: n, leafIndex: Int32Array.from({ length: n }, (_, i) => i), boxMin, boxMax, leafStart, order: Uint32Array.from({ length: cloud.count }, (_, i) => i) },
    levels: [{ leafStart }],
  };
}

function leafOfPoints(h, count) {
  const oc = h.octree, leafOf = new Int32Array(count);
  for (let k = 0; k < oc.leafCount; k++) for (let q = oc.leafStart[k]; q < oc.leafStart[k + 1]; q++) leafOf[oc.order[q]] = k;
  return leafOf;
}

// 그려진 점의 리프 집합과, 마스크에서 그 중 제거된 수
function audit(h, cloud, mask, cam = CAM) {
  const res = renderPoints(cam, cloud, { pointSizeM: SIZE_M });
  const leafOf = leafOfPoints(h, cloud.count);
  const seen = new Set();
  for (let i = 0; i < res.index.length; i++) if (res.index[i] >= 0) seen.add(leafOf[res.index[i]]);
  let falseRemoved = 0, kept = 0;
  for (const k of seen) if (mask[k] === 0) falseRemoved++;
  for (const m of mask) kept += m;
  return { visibleLeaves: seen.size, falseRemoved, kept };
}

function maskWith(h, fn) {
  const oc = h.octree, mask = new Uint8Array(oc.leafCount);
  for (let node = 0; node < oc.nodeCount; node++) {
    const k = oc.leafIndex[node];
    if (k < 0 || h.levels[0].leafStart[k + 1] === h.levels[0].leafStart[k]) continue;
    if (fn(oc.boxMin.subarray(3 * node, 3 * node + 3), oc.boxMax.subarray(3 * node, 3 * node + 3))) mask[k] = 1;
  }
  return mask;
}

const scene = (seed, n, cam) => { const { cloud, leafStart } = edgeScene(seed, n, cam); return { cloud, h: tightHierarchy(cloud, leafStart) }; };
const onePoint = (p) => { const cloud = cloudOf(p); return { cloud, h: tightHierarchy(cloud, Uint32Array.from([0, 1])) }; };

test('F-116 반례: 깊이 1 m·u = −1 인 점 하나는 래스터에 524 픽셀로 그려지고 마스크 1', () => {
  const { cloud, h } = onePoint(unproject(-1, 270, 1));
  const res = renderPoints(CAM, cloud, { pointSizeM: SIZE_M });
  let px = 0; for (const i of res.index) if (i === 0) px++;
  assert.equal(px, 524);
  assert.deepEqual([...frustumCull(h, CAM, { pointSizeM: SIZE_M })], [1]);
  // 원판 여유를 지우면(pointSizeM 0 = 원판 중심만) 같은 반례에서 0 이 된다(변이 검출).
  assert.deepEqual([...frustumCull(h, CAM, { pointSizeM: 0 })], [0]);
  // pointSizeM 이 없으면 좌·우·위·아래로는 제거하지 않는다.
  assert.deepEqual([...frustumCull(h, CAM)], [1]);
  assert.deepEqual([...frustumCull(h, CAM, {})], [1]);
});

test('F-116 반례: 반경 바로 바깥(u = −r − 0.5)·깊이 1 m 점은 그려지지 않고 마스크 0', () => {
  const r = (CAM.K.fx * SIZE_M) / 2;
  const { cloud, h } = onePoint(unproject(-r - 0.5, 270, 1));
  const res = renderPoints(CAM, cloud, { pointSizeM: SIZE_M });
  assert.equal(res.index.some((i) => i >= 0), false);
  assert.deepEqual([...frustumCull(h, CAM, { pointSizeM: SIZE_M })], [0]);
});

// 고정 시드 장면 3개의 구운 값: [시드, 리프 수, 점 수, 보이는 리프, 남김(서버), 원판 여유 없는 변이의 거짓 제거]
const ROT_VISIBLE = 300, ROT_MUT_FALSE = 97;
const EDGE_CASES = [
  [11, 1500, 3820, 318, 1218, 107],
  [12, 1500, 3792, 291, 1211, 98],
  [13, 1500, 3717, 333, 1194, 127],
];

for (const [seed, n, pointCount, visible, kept, mutFalse] of EDGE_CASES) {
  test(`F-116 가장자리 바깥 0~r px 장면(시드 ${seed}): 그려진 점의 리프 제거 0, 원판 여유 없는 변이는 실패`, () => {
    const { cloud, h } = scene(seed, n);
    assert.equal(cloud.count, pointCount);
    const mask = frustumCull(h, CAM, { pointSizeM: SIZE_M });
    const a = audit(h, cloud, mask);
    assert.equal(a.visibleLeaves, visible);
    assert.equal(a.falseRemoved, 0);
    assert.equal(a.kept, kept);
    // 서버 마스크는 공용 boxMayBeVisibleSplat 을 리프마다 쓴 것과 같다.
    assert.deepEqual([...mask], [...maskWith(h, (mn, mx) => boxMayBeVisibleSplat(CAM, mn, mx, SIZE_M))]);
    // 변이 1: 원판 여유 0(pointSizeM 0) → 거짓 제거가 생긴다.
    assert.equal(audit(h, cloud, frustumCull(h, CAM, { pointSizeM: 0 })).falseRemoved, mutFalse);
  });
}

test('F-116 변이: view_check.mjs 소스에서 원판 여유 항을 지우면 가장자리 장면에서 거짓 제거가 생긴다', async () => {
  const url = new URL('../../lod/select/view_check.mjs', import.meta.url);
  const src = readFileSync(url, 'utf8');
  const MARGIN = '0.5 * camera.K.fx * pointSizeM';
  assert.equal(src.split(MARGIN).length, 2, '원판 여유 식이 소스에 정확히 한 번 있어야 함');
  const mutated = await import(`data:text/javascript;base64,${Buffer.from(src.replace(MARGIN, '0')).toString('base64')}`);
  const [seed, n, , , , mutFalse] = EDGE_CASES[0];
  const { cloud, h } = scene(seed, n);
  const mask = maskWith(h, (mn, mx) => mutated.boxMayBeVisibleSplat(CAM, mn, mx, SIZE_M));
  assert.equal(audit(h, cloud, mask).falseRemoved, mutFalse);
});

test('F-116 회전 카메라에서도 원판 여유가 유지된다(8 꼭짓점 아핀 판정)', () => {
  // y 축 둘레로 0.4 rad 돌린 카메라, 같은 K. 카메라 좌표에서 가장자리 바깥 0~r px 에 점을 둔 뒤 세계로 되돌린다.
  const c = Math.cos(0.4), s = Math.sin(0.4);
  const cam = { ...CAM, R: [c, 0, -s, 0, 1, 0, s, 0, c], t: [0.3, -0.2, 1.5] };
  const { cloud: base, leafStart } = edgeScene(21, 1000, cam);
  const pos = base.positions;
  for (let i = 0; i < base.count; i++) {
    const xc = [pos[3 * i] - cam.t[0], pos[3 * i + 1] - cam.t[1], pos[3 * i + 2] - cam.t[2]];
    // X_w = Rᵀ·(X_c − t)
    for (let a = 0; a < 3; a++) pos[3 * i + a] = cam.R[a] * xc[0] + cam.R[3 + a] * xc[1] + cam.R[6 + a] * xc[2];
  }
  const h = tightHierarchy(base, leafStart);
  const a = audit(h, base, frustumCull(h, cam, { pointSizeM: SIZE_M }), cam);
  assert.equal(a.visibleLeaves, ROT_VISIBLE);
  assert.equal(a.falseRemoved, 0);
  assert.equal(audit(h, base, frustumCull(h, cam, { pointSizeM: 0 }), cam).falseRemoved, ROT_MUT_FALSE);
});

test('pointSizeM 입력 오류는 cull: 오류, null 은 없음과 같음', () => {
  const { h } = onePoint(unproject(-1, 270, 1));
  for (const bad of [-0.01, NaN, Infinity, '0.05']) assert.throws(() => frustumCull(h, CAM, { pointSizeM: bad }), /^Error: cull:/);
  assert.throws(() => frustumCull(h, CAM, 0.05), /^Error: cull:/);
  assert.deepEqual([...frustumCull(h, CAM, { pointSizeM: null })], [1]);
  assert.deepEqual([...frustumCull(h, CAM, null)], [1]);
});

test('pointSizeM 이 없으면 좌·우·위·아래 밖 리프도 남기고 카메라 뒤 리프만 제거한다', () => {
  const cloud = cloudOf([...unproject(-5000, 270, 2), ...unproject(480, 270, 3), 0, 0, -4]);
  const h = tightHierarchy(cloud, Uint32Array.from([0, 1, 2, 3]));
  assert.deepEqual([...frustumCull(h, CAM)], [1, 1, 0]);
  assert.deepEqual([...frustumCull(h, CAM, { pointSizeM: SIZE_M })], [0, 1, 0]);
});
