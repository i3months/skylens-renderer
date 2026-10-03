// F-116 (클라이언트): clientFrustumCull 도 점 원판 반경 r = fx·sizeM/(2d) 만큼 좌·우·위·아래 평면을 바깥으로 민다.
// 참조 래스터(server/raster_ref/zbuffer)가 그린 점(index ≥ 0)의 리프 제거 0, 서버 frustumCull 과 같은 마스크.
// 수치는 모두 고정 시드로 미리 구워 둔 값이다(사후 문턱 없음). 서버 모듈은 시험에서만 import 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFrustumCull } from './index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';
import { frustumCull } from '../../server/cull/frustum/index.mjs';

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

const cloudOf = (pts) => {
  const n = pts.length / 3;
  return { format: 1, count: n, positions: Float32Array.from(pts), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) };
};
const unproject = (u, v, d) => [((u - CAM.K.cx) * d) / CAM.K.fx, ((v - CAM.K.cy) * d) / CAM.K.fy, d];

// 리프마다 점 1~4 개를 한 가장자리 바깥 0~r px 에 비슷한 깊이(1~8 m)로 모은다. 20% 는 미끼(5r~10r 바깥).
function edgeScene(seed, leafCount) {
  const r = rng(seed), pts = [], leafStart = [0];
  for (let k = 0; k < leafCount; k++) {
    const decoy = r() < 0.2;
    const side = Math.floor(r() * 4);
    const d0 = 1 + 7 * r(), along0 = r();
    const m = 1 + Math.floor(r() * 4);
    for (let j = 0; j < m; j++) {
      const d = d0 * (1 + 0.05 * r());
      const rad = (CAM.K.fx * SIZE_M) / (2 * d);
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

// 리프 상자 = 리프 점들의 꼭 맞는 AABB(가장 엄격한 경우)
function tightBoxes(cloud, leafStart) {
  const n = leafStart.length - 1, pos = cloud.positions;
  const boxMin = new Float32Array(3 * n).fill(Infinity), boxMax = new Float32Array(3 * n).fill(-Infinity);
  for (let k = 0; k < n; k++) for (let i = leafStart[k]; i < leafStart[k + 1]; i++) for (let a = 0; a < 3; a++) {
    boxMin[3 * k + a] = Math.min(boxMin[3 * k + a], pos[3 * i + a]);
    boxMax[3 * k + a] = Math.max(boxMax[3 * k + a], pos[3 * i + a]);
  }
  return { boxMin, boxMax };
}
// 같은 상자를 서버 frustumCull 이 받는 최소 계층으로
function hierarchyOf(boxes, leafStart) {
  const n = leafStart.length - 1;
  return { octree: { nodeCount: n, leafCount: n, leafIndex: Int32Array.from({ length: n }, (_, i) => i), boxMin: boxes.boxMin, boxMax: boxes.boxMax }, levels: [{ leafStart }] };
}

function audit(cloud, leafStart, mask) {
  const res = renderPoints(CAM, cloud, { pointSizeM: SIZE_M });
  const leafOf = new Int32Array(cloud.count);
  for (let k = 0; k + 1 < leafStart.length; k++) for (let i = leafStart[k]; i < leafStart[k + 1]; i++) leafOf[i] = k;
  const seen = new Set();
  for (const p of res.index) if (p >= 0) seen.add(leafOf[p]);
  let falseRemoved = 0, kept = 0;
  for (const k of seen) if (mask[k] === 0) falseRemoved++;
  for (const m of mask) kept += m;
  return { visibleLeaves: seen.size, falseRemoved, kept };
}

test('F-116 반례(클라이언트): 깊이 1 m·u = −1 점 하나의 꼭 맞는 상자는 마스크 1, 원판 여유 0 이면 0', () => {
  const p = Float32Array.from(unproject(-1, 270, 1));
  const boxes = { boxMin: p, boxMax: Float32Array.from(p) };
  assert.deepEqual([...clientFrustumCull(boxes, CAM, { pointSizeM: SIZE_M })], [1]);
  assert.deepEqual([...clientFrustumCull(boxes, CAM, { pointSizeM: 0 })], [0]);
  assert.deepEqual([...clientFrustumCull(boxes, CAM)], [1]); // pointSizeM 없음: 좌·우·위·아래 제거 없음
  const q = Float32Array.from(unproject(-(CAM.K.fx * SIZE_M) / 2 - 0.5, 270, 1)); // 반경 바로 바깥
  assert.deepEqual([...clientFrustumCull({ boxMin: q, boxMax: Float32Array.from(q) }, CAM, { pointSizeM: SIZE_M })], [0]);
});

// 서버 시험(server/cull/frustum/frustum_disc.test.mjs)과 같은 시드·같은 구운 값:
// [시드, 리프 수, 점 수, 보이는 리프, 남김, 원판 여유 없는 변이의 거짓 제거]
const EDGE_CASES = [
  [11, 1500, 3820, 318, 1218, 107],
  [12, 1500, 3792, 291, 1211, 98],
  [13, 1500, 3717, 333, 1194, 127],
];

for (const [seed, n, pointCount, visible, kept, mutFalse] of EDGE_CASES) {
  test(`F-116 가장자리 바깥 0~r px 장면(시드 ${seed}, 클라이언트): 그려진 점의 리프 제거 0, 서버와 같은 마스크`, () => {
    const { cloud, leafStart } = edgeScene(seed, n);
    assert.equal(cloud.count, pointCount);
    const boxes = tightBoxes(cloud, leafStart);
    const mask = clientFrustumCull(boxes, CAM, { pointSizeM: SIZE_M });
    const a = audit(cloud, leafStart, mask);
    assert.equal(a.visibleLeaves, visible);
    assert.equal(a.falseRemoved, 0);
    assert.equal(a.kept, kept);
    assert.deepEqual([...mask], [...frustumCull(hierarchyOf(boxes, leafStart), CAM, { pointSizeM: SIZE_M })]);
    assert.equal(audit(cloud, leafStart, clientFrustumCull(boxes, CAM, { pointSizeM: 0 })).falseRemoved, mutFalse);
  });
}

// F-127 ⑤: 소스 문자열을 바꾸는 변이 테스트는 삭제했다. 같은 보증(원판 여유가 없으면 거짓 제거가 생김)은
// 위 EDGE_CASES 루프의 pointSizeM:0 대조(mutFalse)가 동작으로 확인한다.
