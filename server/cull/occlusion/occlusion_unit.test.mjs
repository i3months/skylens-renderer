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
import { buildDepthPyramid, occlusionCull, buildDepthPyramidWith, occlusionCullWith, DEFAULT_MAX_OCCLUDER_POINTS } from './index.mjs';

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

/** 손으로 만든 계층: groups[k] = 리프 k 의 점 [[x,y,z],...]. 노드 0 = 뿌리(리프 아님), 노드 k+1 = 리프 k. 단계 0 하나. */
function handHierarchy(groups) {
  const L = groups.length, pts = groups.flat();
  const positions = new Float32Array(pts.flat());
  const leafStart = new Uint32Array(L + 1);
  groups.forEach((g, k) => { leafStart[k + 1] = leafStart[k] + g.length; });
  const boxMin = new Float32Array(3 * (L + 1)).fill(Infinity), boxMax = new Float32Array(3 * (L + 1)).fill(-Infinity);
  const leafIndex = new Int32Array(L + 1).fill(-1);
  groups.forEach((g, k) => {
    leafIndex[k + 1] = k;
    for (const p of g) for (let d = 0; d < 3; d++) {
      const x = Math.fround(p[d]);
      for (const node of [0, k + 1]) {
        boxMin[3 * node + d] = Math.min(boxMin[3 * node + d], x);
        boxMax[3 * node + d] = Math.max(boxMax[3 * node + d], x);
      }
    }
  });
  const h = { octree: { nodeCount: L + 1, leafCount: L, leafIndex, boxMin, boxMax }, levels: [{ positions, leafStart }] };
  const normals = new Float32Array(positions.length), colors = new Uint8Array(positions.length).fill(128);
  for (let i = 0; i < pts.length; i++) normals[3 * i + 2] = -1;
  const leafOfPoint = new Int32Array(pts.length);
  for (let k = 0; k < L; k++) leafOfPoint.fill(k, leafStart[k], leafStart[k + 1]);
  return { h, cloud: { format: 1, count: pts.length, positions, normals, colors }, leafOfPoint };
}

// 카메라 평면에 걸친 상자(F-119 ①). 이 판정을 지우면(index.mjs 의 `nearHit ||`) 실제 가림막 앞에서 상자를 지워야 시험이 잡는다.
// 카메라: 원점, R = diag(1,−1,−1)(−z 를 봄, 카메라 깊이 = −Z). 꼭짓점 순서상 c = 0..3 이 Z = 최소(카메라에서 가장 먼) 면이라
//   c = 4 에서 카메라 뒤 꼭짓점을 만나 멈출 때 이미 유한한 u,v·zmin = 20 이 쌓여 있다. 그래서 `nearHit ||` 를 지우면
//   판정이 계속되어 먼 면(깊이 20, 화면 ±5 px)만 보고 벽(깊이 10, 화면 전체)에 가렸다고 지운다.
// 장면: 벽 리프(Z = −10, |x|,|y| ≤ 8, 0.1 m 간격, 원판 반경 1 px), 걸친 리프(|x|,|y| ≤ 1),
//   먼 리프(걸친 리프의 깊이 20 판만). 걸친 리프는 깊이 20·−1 두 판과 깊이 0.5 의 한 점(화면 중심)이다.
//   깊이 0.5 점은 벽보다 앞이라 참조 렌더에 보인다 → 걸친 리프를 지우면 거짓 제거다.
//   먼 리프는 같은 벽에 가려 0 이어야 한다(벽이 그 사각형을 실제로 가리는 가림막임을 같은 시험 안에서 확인).
test('카메라 평면에 걸친 상자는 판정 포기(남김): 실제 가림막 앞에서도', () => {
  const wall = [], straddle = [], far = [];
  for (let i = -80; i <= 80; i++) for (let j = -80; j <= 80; j++) wall.push([i / 10, j / 10, -10]);
  for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) {
    for (const Z of [-20, 1]) straddle.push([i / 10, j / 10, Z]);
    far.push([i / 10, j / 10, -20]);
  }
  straddle.push([0, 0, -0.5]); // 깊이 0.5 의 한 점(원판 반경 20 px): 벽보다 앞이라 보이고, 화면 가장자리의 벽은 가리지 않는다
  const s = handHierarchy([wall, straddle, far]);
  const cam = { ...CAM, R: [1, 0, 0, 0, -1, 0, 0, 0, -1] };
  const r = renderPoints(cam, s.cloud, { pointSizeM: PS });
  assert.ok(r.index.some((i) => i >= 0 && s.leafOfPoint[i] === 1), '전제: 걸친 리프의 깊이 0.5 점이 참조 렌더에 보인다');
  assert.ok(!r.index.some((i) => i >= 0 && s.leafOfPoint[i] === 2), '전제: 먼 리프는 참조 렌더에 보이지 않는다');
  const m = occlusionCull(s.h, cam, buildDepthPyramid(s.h, cam, { size: 16, pointSizeM: PS }));
  assert.deepEqual([...m], [1, 1, 0], '벽 1 · 걸친 리프 1(판정 포기) · 먼 리프 0(같은 벽에 가림)');
  // 기존 장면(벽이 카메라 뒤)도 그대로 남김
  const s0 = makeScene({ hole: false });
  const cam0 = { ...CAM, t: [0, 0, -21] };
  const m0 = occlusionCull(s0.h, cam0, buildDepthPyramid(s0.h, cam0, { size: 16, pointSizeM: PS }));
  for (const k of s0.boxLeaves) assert.equal(m0[k], 1);
});

// 판정 사각형의 여유(F-119 ②). 손 계산 장면: 64×64, size 64(0 단계 칸 = 블록 = 픽셀), fx = fy = 100, cx = cy = 32, R = I, 점 지름 0.1 m.
//   상자 리프: x,y ∈ {±0.25}, z = 16 → u,v ∈ [32 − 1.5625, 32 + 1.5625] = [30.4375, 33.5625], zmin = 16,
//     원판 반경 100·0.1/32 = 0.3125 → 참조 렌더에서 상자가 칠하는 픽셀 열·행은 30..33.
//     rmax = 0.3125 + 1 = 1.3125 → i0 = ⌊30.4375 − 1.3125 − 0.5⌋ = ⌊28.625⌋ = 28, i1 = ⌊33.5625 + 1.3125⌋ = ⌊34.875⌋ = 34 (j 도 같음).
//     +1 을 빼면 i0 = ⌊29.625⌋ = 29, i1 = ⌊33.875⌋ = 33. 왼쪽 −0.5 를 빼면 i0 = ⌊29.125⌋ = 29.
//   벽 리프: z = 10, 픽셀 중심마다 한 점(x = (i − 31.5)/10), 원판 반경 100·0.1/20 = 0.5 px → 제 픽셀만 덮는다.
//   틈: 벽에서 열 28(상자 칠 영역 왼쪽 2 px)·열 34(오른쪽 1 px)·행 28(위 2 px)·행 34(아래 1 px) 중 하나를 통째로 뺀다.
//   틈 칸은 +∞ 이고 사각형 [28,34]² 의 가장자리라 상자는 1. 틈 없는 벽이면 상자는 0(대조).
//   rmax 의 +1 을 빼면 사각형이 [29,33]² 로 줄어 네 방향 모두 틈을 놓쳐 0, 왼쪽 가장자리를 줄이면 왼쪽 틈을 놓쳐 0 이 된다.
test('판정 사각형은 원판 반경 + 1 px 여유: 상자 옆 1~2 px 에서 끝나는 가림막(네 방향)', () => {
  const C2 = { width: 64, height: 64, K: { fx: 100, fy: 100, cx: 32, cy: 32 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  const PS2 = 0.1;
  const box = [];
  for (const x of [-0.25, 0.25]) for (const y of [-0.25, 0.25]) box.push([x, y, 16]);
  const run = (gap) => {
    const wall = [];
    for (let i = 0; i < 64; i++) for (let j = 0; j < 64; j++) {
      if ((gap.col !== undefined && i === gap.col) || (gap.row !== undefined && j === gap.row)) continue;
      wall.push([(i - 31.5) / 10, (j - 31.5) / 10, 10]);
    }
    const s = handHierarchy([wall, box]);
    const pyr = buildDepthPyramid(s.h, C2, { size: 64, pointSizeM: PS2 });
    if (gap.col !== undefined || gap.row !== undefined) {
      // 틈은 실제로 +∞ 칸이다(이 장면의 손 계산 전제)
      const c = gap.col ?? 32, rr = gap.row ?? 32;
      assert.equal(pyr.levels[0][rr * 64 + c], Infinity, `전제: 틈 ${JSON.stringify(gap)} 칸이 비었음`);
    }
    return occlusionCull(s.h, C2, pyr)[1];
  };
  assert.equal(run({}), 0, '대조: 틈 없는 벽이면 상자는 가려져 0');
  // 네 방향을 한꺼번에 비교해 어긋난 방향이 모두 보이게 한다.
  // 사각형 가장자리(28·34)의 틈은 1, 한 칸 더 밖(27·35)의 틈은 판정에 들지 않아 0 — 경계가 손 계산과 정확히 같음을 양쪽에서 고정한다.
  const got = {}, want = {};
  for (const [name, inside, outside] of [['왼쪽', { col: 28 }, { col: 27 }], ['오른쪽', { col: 34 }, { col: 35 }], ['위', { row: 28 }, { row: 27 }], ['아래', { row: 34 }, { row: 35 }]]) {
    got[name] = [run(inside), run(outside)];
    want[name] = [1, 0];
  }
  assert.deepEqual(got, want, '[사각형 가장자리 틈 → 1, 한 칸 밖 틈 → 0]');
});

const sameLevels = (a, b) => a.levels.length === b.levels.length && a.levels.every((l, i) => Buffer.from(l.buffer).equals(Buffer.from(b.levels[i].buffer)));

// F-121 (a): 반경 상한이 rNeed 보다 작은 리프는 투영하지 않아도 피라미드가 비트 단위로 같다.
// 512×512, fx = fy = 400, size 16 → 블록 64×64 개, 블록 8×8 px → rNeed = √(7²+7²)/2 ≈ 4.95 px.
// 점 지름 0.3: 벽(z = 10) 반경 6 px 는 투영, 상자(z ≥ 20) 반경 ≤ 3 px 는 생략된다.
test('가림막 정확한 생략: 피라미드는 생략 전과 같고 투영 점 수만 준다', () => {
  const s = makeScene({ hole: true });
  const cam = { width: 512, height: 512, K: { fx: 400, fy: 400, cx: 256, cy: 256 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  const opts = { size: 16, pointSizeM: 0.3, maxOccluderPoints: Infinity };
  const full = buildDepthPyramidWith(s.h, cam, opts, { noExactSkip: true });
  const fast = buildDepthPyramid(s.h, cam, opts);
  assert.ok(sameLevels(full, fast), '생략이 피라미드를 바꿈');
  const boxPts = s.isBox.filter(Boolean).length;
  assert.equal(full.occluderPoints - fast.occluderPoints, boxPts, '상자 리프(반경 ≤ 3 px)만 생략되어야 함');
  assertConservative(fast, cam, s.cloud);
  // 128×128, size 16: 블록 2×2 px → rNeed = √2/2 ≈ 0.71. 벽 반경 1 px 는 투영, 상자 반경 ≤ 0.5 px 는 생략. 피라미드는 같다.
  const small = { size: 16, pointSizeM: PS, maxOccluderPoints: Infinity };
  const a = buildDepthPyramidWith(s.h, CAM, small, { noExactSkip: true }), b = buildDepthPyramid(s.h, CAM, small);
  assert.ok(sameLevels(a, b));
  assert.equal(a.occluderPoints - b.occluderPoints, boxPts);
  // 100×100, size 64: 블록 폭이 1 또는 2 px 라 1×1 블록이 있다('중심 칸' 규칙으로 어떤 점이든 덮을 수 있음) → rNeed = 0, 생략 없음.
  const cam1 = { ...CAM, width: 100, height: 100, K: { fx: 100, fy: 100, cx: 50, cy: 50 } };
  const o1 = { size: 64, pointSizeM: PS, maxOccluderPoints: Infinity };
  const c = buildDepthPyramidWith(s.h, cam1, o1, { noExactSkip: true }), d = buildDepthPyramid(s.h, cam1, o1);
  assert.ok(sameLevels(c, d));
  assert.equal(c.occluderPoints, d.occluderPoints, '1×1 블록이 있으면 생략하지 않는다');
});

// F-121 (b): 가림막 점 수 상한. 가까운 리프부터 채우고, 부분집합이라 보수 관계는 그대로다.
test('가림막 점 수 상한: 가까운 리프 우선, 0 이면 가림막 없음, 잘못된 값은 오류', () => {
  assert.equal(DEFAULT_MAX_OCCLUDER_POINTS, 262144);
  const s = makeScene({ hole: false });
  const L = s.h.octree.leafCount;
  const wallMask = new Uint8Array(L).fill(1);
  for (const k of s.boxLeaves) wallMask[k] = 0;
  // size 64(블록 = 픽셀, rNeed = 0)라 정확한 생략이 없어 상자 리프도 후보다.
  const wallOnly = buildDepthPyramid(s.h, CAM, { size: 64, pointSizeM: PS, occluderMask: wallMask, maxOccluderPoints: Infinity });
  assert.ok(wallOnly.occluderPoints > 0);
  assert.equal(buildDepthPyramid(s.h, CAM, { size: 64, pointSizeM: PS, maxOccluderPoints: Infinity }).occluderPoints,
    wallOnly.occluderPoints + s.isBox.filter(Boolean).length, '전제: 상한이 없으면 상자 리프도 가림막 후보');
  // 상한 = 시야 안 벽 점 수 그대로: 벽(z = 10)이 상자(z ≥ 20)보다 가까우므로 벽 리프만 정확히 채운다.
  const capped = buildDepthPyramid(s.h, CAM, { size: 64, pointSizeM: PS, maxOccluderPoints: wallOnly.occluderPoints });
  assert.equal(capped.occluderPoints, wallOnly.occluderPoints);
  assert.ok(sameLevels(capped, wallOnly), '상한 안에서 가까운 벽 리프가 아니라 다른 리프를 골랐음');
  const m = occlusionCull(s.h, CAM, capped);
  for (const k of s.boxLeaves) assert.equal(m[k], 0, `상한이 있어도 벽 뒤 상자 리프 ${k} 는 0`);
  // 상한이 작으면 가림막이 줄 뿐(칸 값 ≥ 상한 없는 값) 보수 관계는 지켜진다.
  const full = buildDepthPyramid(s.h, CAM, { size: 16, pointSizeM: PS, maxOccluderPoints: Infinity });
  for (const cap of [0, 1000, 10000]) {
    const p = buildDepthPyramid(s.h, CAM, { size: 16, pointSizeM: PS, maxOccluderPoints: cap });
    assert.ok(p.occluderPoints <= cap);
    for (let c = 0; c < 16 * 16; c++) assert.ok(p.levels[0][c] >= full.levels[0][c], `상한 ${cap} 칸 ${c}`);
    if (cap > 0) assertConservative(p, CAM, s.cloud);
    else {
      assert.ok(p.levels[0].every((v) => v === Infinity));
      assert.ok(occlusionCull(s.h, CAM, p).every((v) => v === 1), '가림막이 없으면 아무것도 지우지 않는다');
    }
  }
  for (const bad of [-1, 1.5, NaN, '10', -Infinity]) {
    assert.throws(() => buildDepthPyramid(s.h, CAM, { maxOccluderPoints: bad }), /^Error: cull:.*maxOccluderPoints/, String(bad));
  }
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
