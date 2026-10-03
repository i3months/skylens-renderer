// T08.3 가림 컬링 단위 시험: 큰 벽 뒤 상자는 0, 구멍 난 벽 뒤 상자는 1, 피라미드 단계의 보수 관계,
// 입력 오류('cull:'), 퇴화 시점(빈 마스크, 던지지 않음).
// 장면(손으로 만듦): 카메라 원점, R = I, +z 를 봄, 128×128, fx = fy = 100, 점 지름 0.2 m.
//   벽: z = 10, x,y ∈ [−10, 10], 간격 0.1 m(화면 1 px 간격, 원판 반경 1 px). 화면 전체(±6.4 m)를 덮는다.
//   상자: x,y ∈ [−1, 1], z ∈ {20, 22} 두 판, 간격 0.1 m. 구멍 벽은 |x|,|y| < 0.6 의 벽 점을 뺀다(화면 ±6 px: 구멍 둘레 칸이 일부만 채워져 빈 블록 무시 변이가 드러난다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { assertLeafMask } from '../../../contracts/cull/index.mjs';
import { buildDepthPyramid, occlusionCull, buildDepthPyramidWith, occlusionCullWith } from './index.mjs';

const PS = 0.2;
const CAM = Object.freeze({ width: 128, height: 128, K: { fx: 100, fy: 100, cx: 64, cy: 64 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

function makeScene({ hole }) {
  const pts = [], isBox = [];
  for (let i = -100; i <= 100; i++) for (let j = -100; j <= 100; j++) {
    const x = i / 10, y = j / 10;
    if (hole && Math.abs(x) < 0.6 && Math.abs(y) < 0.6) continue;
    pts.push([x, y, 10]); isBox.push(false);
  }
  for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) for (const z of [20, 22]) { pts.push([i / 10, j / 10, z]); isBox.push(true); }
  const n = pts.length;
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n).fill(128);
  pts.forEach((p, i) => { positions.set(p, 3 * i); normals[3 * i + 2] = -1; });
  const cloud = { format: 1, count: n, positions, normals, colors };
  const h = buildHierarchy(cloud, { edge0M: 0.1, levelCount: 2, maxLeafPoints: 2000 });
  const oc = h.octree, leafOf = new Int32Array(n);
  for (let k = 0; k < oc.leafCount; k++) for (let s = oc.leafStart[k]; s < oc.leafStart[k + 1]; s++) leafOf[oc.order[s]] = k;
  // 상자 리프 = 상자 점이 든 리프. 전제: 그 리프에 벽 점이 섞이지 않는다.
  const boxLeaves = new Set(), wallLeaves = new Set();
  for (let i = 0; i < n; i++) (isBox[i] ? boxLeaves : wallLeaves).add(leafOf[i]);
  for (const k of boxLeaves) assert.ok(!wallLeaves.has(k), '전제: 상자 리프와 벽 리프가 분리됨');
  return { cloud, h, leafOf, boxLeaves: [...boxLeaves], isBox };
}

test('큰 벽이 앞을 가린 상자 리프는 0, 벽 리프는 1', () => {
  const s = makeScene({ hole: false });
  const r = renderPoints(CAM, s.cloud, { pointSizeM: PS });
  for (const i of r.index) assert.ok(i >= 0 && !s.isBox[i], '전제: 참조 렌더에서 상자 점은 보이지 않고 빈 픽셀이 없다');
  const pyr = buildDepthPyramid(s.h, CAM, { size: 16, pointSizeM: PS });
  const m = occlusionCull(s.h, CAM, pyr);
  assertLeafMask(m, s.h.octree.leafCount);
  assert.ok(s.boxLeaves.length >= 1);
  for (const k of s.boxLeaves) assert.equal(m[k], 0, `상자 리프 ${k}`);
  for (let k = 0; k < m.length; k++) if (!s.boxLeaves.includes(k)) assert.equal(m[k], 1, `벽 리프 ${k}`);
});

test('구멍 난 벽 뒤 상자 리프는 1(빈자리는 가림막이 아니다)', () => {
  const s = makeScene({ hole: true });
  const r = renderPoints(CAM, s.cloud, { pointSizeM: PS });
  assert.ok(r.index.some((i) => i >= 0 && s.isBox[i]), '전제: 참조 렌더에서 상자 점이 보인다');
  const m = occlusionCull(s.h, CAM, buildDepthPyramid(s.h, CAM, { size: 16, pointSizeM: PS }));
  for (const k of s.boxLeaves) assert.equal(m[k], 1, `상자 리프 ${k}`);
  // 변이: 빈 블록을 무시하면 구멍 둘레 칸이 가림막이 되어 상자를 잘못 지운다.
  const mm = occlusionCullWith(s.h, CAM, buildDepthPyramidWith(s.h, CAM, { size: 16, pointSizeM: PS }, { emptyAsOccluder: true }), {});
  assert.ok(s.boxLeaves.some((k) => mm[k] === 0), '변이 emptyAsOccluder 가 구멍 뒤 상자를 지우지 않음(시험이 약함)');
});

/** 피라미드 보수 관계: 부모 = 자식 2×2 최댓값(≥ 각 자식), 0 단계 유한 칸의 모든 픽셀은 참조 렌더 깊이 ≤ 칸 값. */
function assertConservative(pyr, cam, cloud) {
  const { size, levels } = pyr;
  assert.equal(levels.length, Math.log2(size) + 1);
  for (let k = 1; k < levels.length; k++) {
    const s = size >> k, ps = size >> (k - 1);
    for (let b = 0; b < s; b++) for (let a = 0; a < s; a++) {
      const ch = [levels[k - 1][2 * b * ps + 2 * a], levels[k - 1][2 * b * ps + 2 * a + 1], levels[k - 1][(2 * b + 1) * ps + 2 * a], levels[k - 1][(2 * b + 1) * ps + 2 * a + 1]];
      const p = levels[k][b * s + a];
      for (const c of ch) assert.ok(p >= c, `단계 ${k} 칸 (${a},${b}) ${p} < 자식 ${c}`);
      assert.equal(p, Math.max(...ch));
    }
  }
  const r = renderPoints(cam, cloud, { pointSizeM: pyr.pointSizeM, validate: false });
  let finite = 0;
  for (let j = 0; j < cam.height; j++) for (let i = 0; i < cam.width; i++) {
    const c = levels[0][Math.floor((j * size) / cam.height) * size + Math.floor((i * size) / cam.width)];
    if (c === Infinity) continue;
    finite++;
    const d = r.depth[j * cam.width + i];
    assert.ok(d > 0 && d <= c, `픽셀 (${i},${j}) 깊이 ${d} 가 가림막 깊이 ${c} 보다 멀거나 비었음`);
  }
  return finite;
}

test('피라미드 각 단계는 상위 칸의 보수 관계를 지킨다(벽·구멍 벽)', () => {
  for (const hole of [false, true]) {
    const s = makeScene({ hole });
    const pyr = buildDepthPyramid(s.h, CAM, { size: 16, pointSizeM: PS });
    const finite = assertConservative(pyr, CAM, s.cloud);
    assert.ok(finite > 0, '가림막 칸이 하나도 없음');
    if (hole) {
      // 구멍 한가운데 칸(화면 중심)은 가림막이 아니다(+∞) — 상자 점이 보이는 곳이다.
      assert.equal(pyr.levels[0][8 * 16 + 8], Infinity);
      assert.equal(pyr.levels[pyr.levels.length - 1][0], Infinity);
    } else {
      assert.equal(finite, 128 * 128, '벽이 화면을 다 덮으면 모든 칸이 가림막');
    }
  }
});

test('변이: 피라미드를 최솟값으로 쌓으면 보수 관계 시험이 잡는다', () => {
  const s = makeScene({ hole: true });
  const bad = buildDepthPyramidWith(s.h, CAM, { size: 16, pointSizeM: PS }, { pyramidMin: true });
  assert.throws(() => assertConservative(bad, CAM, s.cloud));
  const noShrink = buildDepthPyramidWith(s.h, CAM, { size: 16, pointSizeM: 0.02 }, { noShrink: true });
  assert.throws(() => assertConservative(noShrink, CAM, s.cloud), '변이 noShrink(작은 점이 블록 전체를 덮는다고 봄)를 잡지 못함');
});

test('카메라 평면에 걸친 상자는 판정 포기(남김)', () => {
  const s = makeScene({ hole: false });
  const cam = { ...CAM, t: [0, 0, -21] }; // 상자 판(z 20, 22) 사이에 카메라 평면
  const m = occlusionCull(s.h, cam, buildDepthPyramid(s.h, cam, { size: 16, pointSizeM: PS }));
  for (const k of s.boxLeaves) assert.equal(m[k], 1);
});

test("입력 오류는 'cull:' 오류", () => {
  const s = makeScene({ hole: false });
  assert.throws(() => occlusionCull(null, CAM), /^Error: cull:/);
  assert.throws(() => occlusionCull({ octree: {} , levels: [] }, CAM), /^Error: cull:/);
  assert.throws(() => occlusionCull(s.h, null), /^Error: cull:/);
  assert.throws(() => occlusionCull(s.h, { ...CAM, R: [1, 0, 0] }), /^Error: cull:/);
  assert.throws(() => buildDepthPyramid(s.h, CAM, { size: 63 }), /^Error: cull:/);
  assert.throws(() => buildDepthPyramid(s.h, CAM, { size: 0 }), /^Error: cull:/);
  assert.throws(() => buildDepthPyramid(s.h, CAM, { pointSizeM: -1 }), /^Error: cull:/);
  assert.throws(() => buildDepthPyramid(s.h, CAM, { occluderLevel: 5 }), /^Error: cull:/);
  assert.throws(() => buildDepthPyramid(s.h, CAM, { occluderMask: new Uint8Array(1) }), /^Error: cull:/);
  const pyr = buildDepthPyramid(s.h, CAM, { size: 16, pointSizeM: PS });
  assert.throws(() => occlusionCull(s.h, { ...CAM, t: [0, 0, 1] }, pyr), /^Error: cull:.*카메라/);
  assert.throws(() => occlusionCull(s.h, CAM, { size: 16, levels: [] }), /^Error: cull:/);
});

test('퇴화 시점은 던지지 않고 빈 마스크(전부 0)', () => {
  const s = makeScene({ hole: false });
  const L = s.h.octree.leafCount;
  const bad = [
    { ...CAM, t: [NaN, 0, 0] },
    { ...CAM, R: [1, 0, 0, 0, 1, 0, 0, 0, Infinity] },
    { ...CAM, K: { ...CAM.K, fx: 0 } },
    { ...CAM, width: 0 },
    { ...CAM, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] },
  ];
  for (const cam of bad) {
    const m = occlusionCull(s.h, cam);
    assertLeafMask(m, L);
    assert.equal(m.reduce((a, b) => a + b, 0), 0);
    const pyr = buildDepthPyramid(s.h, cam);
    assert.equal(pyr.degenerate, true);
    assert.equal(occlusionCull(s.h, cam, pyr).reduce((a, b) => a + b, 0), 0);
  }
});
