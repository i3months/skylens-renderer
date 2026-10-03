// F-125②: 렌더 기본 점 크기 pointSizeM 0.05 m 에서 뒷면·가림 제거가 실제로 일어나는 시점을 두고 결합 경로를 시험한다.
//
// 시험 설계:
//   장면 = flat_boxes 시드 1·점 20만을 배율 1/30 로 줄인 것(200 m 바닥 → 6.67 m). 시점 = fixtures/viewpoints/synthetic.json 8곳을
//   같은 배율로 줄인 것, 320×180·τ 0.5 px·levelCount 6·maxLeafPoints 256. 장면과 시점을 같은 배율로 줄이면 화면 위 기하는 그대로이고
//   원판만 상대적으로 커진다(배율 1/k 축소 = 원래 장면에서 점 지름 0.05·k m). 그래서 0.05 m 원판이 가림막을 '확실히 덮는' 경우가 생긴다.
//   REMOVAL_VIEWS = top_down 을 뺀 7 시점. top_down 은 지붕·바닥만 보이는 정면 시점이라 (a) 에서 뺀다((b)(c) 는 8 시점 모두).
//
// 단언(기준값은 리터럴, 사후에 낮추지 않는다):
//   (a) REMOVAL_VIEWS 의 시점마다 뒷면+가림 제거 리프 수 ≥ MIN_REMOVED(1). 8 시점 합으로 뒷면 ≥ 1, 가림 ≥ 1.
//   (b) 픽셀 동일(F-117): 원본 전체 렌더에서 '제거된 리프의 점'이 이긴 픽셀 수 = 0, 그리고 원본 전체 렌더와
//       남은 리프의 원본 점(단계 0, 순서 유지)만 그린 렌더의 깊이·색·빈 픽셀이 모든 픽셀에서 같다(다른 픽셀 0).
//       가림막 원판 지름이 렌더 지름보다 크면 이 보장이 깨진다 → 아래 변이 시험이 그것을 잡는지 본다.
//   (c) 8 시점 모두 SSIM(원본 전체 렌더, 결합 선택 materialize 렌더) ≥ 0.95(계약 COMBINE_MIN_SSIM).
//   (d) 격자 경계 합성 장면(F-133④): 덮임 판정의 원판 반경이 1 % 만 커져도 제거/남김이 바뀌는 장면을 해석적으로 만들어,
//       가림·뒷면 단계의 결과를 숫자로 고정한다(설계는 아래 '격자 경계 장면' 머리말).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate as genFlat } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { mulberry32 } from '../../../contracts/scenes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { ssim } from '../../metrics/ssim/index.mjs';
import { COMBINE_MIN_SSIM } from '../../../contracts/cull/index.mjs';
import { buildHierarchy, materialize } from '../../lod/select/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../occlusion/index.mjs';
import { cullAndSelect, loadDefaultImpls } from './index.mjs';

const SSIM_MIN = 0.95;
const MIN_REMOVED = 1; // 시점마다 뒷면+가림 제거 > 0
const POINT_SIZE_M = 0.05; // 렌더 기본 점 지름
const SCALE = 1 / 30;
const W = 320, H = 180, TAU = 0.5, LEVEL_COUNT = 6, MAX_LEAF = 256;
const EDGE0_M = 0.5 * SCALE; // combine_quality 의 flat_boxes edge0M 0.5 를 같은 배율로 줄임
const STAGES = ['frustum', 'backface', 'occlusion', 'distance'];
const REMOVAL_VIEWS = ['aerial_overview', 'aerial_oblique_ne', 'street_level', 'low_close_box', 'tower_high', 'tower_mid', 'edge_far'];
// 변이: 가림 피라미드의 원판 지름을 렌더 지름의 이 배수로 키운다. 변이 시험은 REMOVAL_VIEWS 중 지면·근접 시점 3곳만 돈다.
const MUT_FACTOR = 2;
const MUT_VIEWS = ['street_level', 'low_close_box', 'edge_far'];

const VPS = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints
  .map((vp) => ({ name: vp.name, eye: vp.eye.map((x) => x * SCALE), target: vp.target.map((x) => x * SCALE), up: vp.up, fov: vp.fov_y_deg }));

let scene;
/** 축소 장면·계층·점→리프 표를 한 번만 만든다. */
function getScene() {
  if (scene) return scene;
  const src = genFlat({ seed: 1, count: 200000 }).cloud;
  const positions = new Float32Array(src.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = src.positions[i] * SCALE;
  const cloud = { format: 1, count: src.count, positions, normals: src.normals, colors: src.colors };
  const h = buildHierarchy(cloud, { edge0M: EDGE0_M, levelCount: LEVEL_COUNT, maxLeafPoints: MAX_LEAF });
  const oc = h.octree;
  const leafOf = new Uint32Array(cloud.count);
  for (let k = 0; k < oc.leafCount; k++) for (let i = oc.leafStart[k]; i < oc.leafStart[k + 1]; i++) leafOf[oc.order[i]] = k;
  scene = { cloud, h, leafOf, full: new Map() };
  return scene;
}

/** 마스크 1 리프의 원본 점만 원래 순서대로 모은 점군(같은 깊이 동률 규칙이 원본 렌더와 같게). */
function keptCloud(cloud, leafOf, mask) {
  let n = 0;
  for (let i = 0; i < cloud.count; i++) if (mask[leafOf[i]] === 1) n++;
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
  for (let i = 0, o = 0; i < cloud.count; i++) {
    if (mask[leafOf[i]] !== 1) continue;
    positions.set(cloud.positions.subarray(3 * i, 3 * i + 3), 3 * o);
    normals.set(cloud.normals.subarray(3 * i, 3 * i + 3), 3 * o);
    colors.set(cloud.colors.subarray(3 * i, 3 * i + 3), 3 * o);
    o++;
  }
  return { format: 1, count: n, positions, normals, colors };
}

/** 두 렌더의 깊이·색·빈 픽셀이 다른 픽셀 수. */
function diffPixels(a, b) {
  let n = 0;
  for (let p = 0; p < a.depth.length; p++) {
    if ((a.index[p] < 0) !== (b.index[p] < 0) || !Object.is(a.depth[p], b.depth[p])
      || a.color[3 * p] !== b.color[3 * p] || a.color[3 * p + 1] !== b.color[3 * p + 1] || a.color[3 * p + 2] !== b.color[3 * p + 2]) n++;
  }
  return n;
}

/**
 * 한 시점: 결합 선택(stageImpls), 원본 전체 렌더, 남은 리프 렌더를 재서 행 하나를 돌려준다.
 * withLod 이면 LOD 렌더 SSIM 도 잰다(변이 시험은 (b) 만 보므로 끈다). 원본 전체 렌더는 시점마다 한 번만 그린다.
 */
function measureView(vp, stageImpls, d, withLod = true) {
  const { cloud, h, leafOf, full: fullCache } = getScene();
  const cam = viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov });
  const r = cullAndSelect(h, cam, { thresholdPx: TAU, stages: STAGES, pointSizeM: POINT_SIZE_M, stageImpls, orderChunks: d.orderChunks, isDegenerateView: d.isDegenerateView });
  const { mask, stats } = r.cull;
  if (!fullCache.has(vp.name)) fullCache.set(vp.name, renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M }));
  const full = fullCache.get(vp.name);
  let winners = 0;
  for (const p of full.index) if (p >= 0 && mask[leafOf[p]] === 0) winners++;
  const kept = renderPoints(cam, keptCloud(cloud, leafOf, mask), { pointSizeM: POINT_SIZE_M });
  let s = NaN;
  if (withLod) s = ssim(full.color, renderPoints(cam, materialize(h, r.selection), { pointSizeM: POINT_SIZE_M }).color, W, H, 3);
  return {
    vp: vp.name, stats, removedBO: stats.removedBackface + stats.removedOcclusion,
    winners, diff: diffPixels(full, kept), ssim: s,
  };
}

/** (b) 픽셀 동일 보장. 어기면 던진다(변이 시험이 같은 함수를 쓴다). */
function checkPixelIdentical(row) {
  assert.equal(row.winners, 0, `${row.vp}: 제거된 리프의 점이 원본 렌더에서 이긴 픽셀 ${row.winners}`);
  assert.equal(row.diff, 0, `${row.vp}: 원본 렌더와 남은 리프 렌더가 다른 픽셀 ${row.diff}`);
}

const line = (row) => `| ${row.vp} | 제거 절두체 ${row.stats.removedFrustum} 뒷면 ${row.stats.removedBackface} 가림 ${row.stats.removedOcclusion} 거리 ${row.stats.removedDistance} | 제거 점 승리 픽셀 ${row.winners} | 다른 픽셀 ${row.diff} | SSIM ${row.ssim.toFixed(4)} |`;

const defaults = await loadDefaultImpls();
const rows = [];

test('기준값: SSIM 하한은 계약 COMBINE_MIN_SSIM, 시점 8곳, 제거 시점은 시점 파일에 있는 이름', () => {
  assert.equal(SSIM_MIN, COMBINE_MIN_SSIM);
  assert.equal(VPS.length, 8);
  for (const n of REMOVAL_VIEWS) assert.ok(VPS.some((v) => v.name === n), n);
  for (const n of MUT_VIEWS) assert.ok(REMOVAL_VIEWS.includes(n), n);
});

for (const vp of VPS) {
  test(`F-125② 점 ${POINT_SIZE_M} m·배율 1/${Math.round(1 / SCALE)} flat_boxes ${vp.name}: 픽셀 동일·SSIM ≥ ${SSIM_MIN}${REMOVAL_VIEWS.includes(vp.name) ? `·뒷면+가림 제거 ≥ ${MIN_REMOVED}` : ''}`, (t) => {
    const row = measureView(vp, defaults.stageImpls, defaults);
    rows.push(row);
    t.diagnostic(line(row));
    if (REMOVAL_VIEWS.includes(vp.name)) assert.ok(row.removedBO >= MIN_REMOVED, `${vp.name}: 뒷면+가림 제거 ${row.removedBO} < ${MIN_REMOVED}`);
    checkPixelIdentical(row);
    assert.ok(row.ssim >= SSIM_MIN, `${vp.name}: SSIM ${row.ssim}`);
  });
}

test('F-125② 8 시점 전체: 모두 측정, 최소 SSIM ≥ 0.95, 뒷면·가림 단계가 각각 하나 이상 제거', (t) => {
  assert.equal(rows.length, 8, '시점별 시험이 먼저 돌아야 함');
  const minS = Math.min(...rows.map((r) => r.ssim));
  const bf = rows.reduce((a, r) => a + r.stats.removedBackface, 0), occ = rows.reduce((a, r) => a + r.stats.removedOcclusion, 0);
  t.diagnostic(`최소 SSIM ${minS.toFixed(4)}, 뒷면 제거 합 ${bf}, 가림 제거 합 ${occ}`);
  assert.ok(minS >= SSIM_MIN);
  assert.ok(bf >= MIN_REMOVED, `뒷면 제거 합 ${bf}`);
  assert.ok(occ >= MIN_REMOVED, `가림 제거 합 ${occ}`);
});

test(`F-125② 변이: 가림 피라미드 원판 지름을 렌더의 ${MUT_FACTOR} 배로 키우면 픽셀 동일 단언이 실패한다`, (t) => {
  const mutated = {
    ...defaults.stageImpls,
    occlusion: (h, cam, o) => occlusionCull(h, cam, buildDepthPyramid(h, cam, { pointSizeM: o.pointSizeM * MUT_FACTOR })),
  };
  let caught = 0;
  for (const vp of VPS.filter((v) => MUT_VIEWS.includes(v.name))) {
    const row = measureView(vp, mutated, defaults, false);
    t.diagnostic(`변이 | ${row.vp} | 가림 ${row.stats.removedOcclusion} | 제거 점 승리 픽셀 ${row.winners} | 다른 픽셀 ${row.diff} |`);
    try { checkPixelIdentical(row); } catch { caught++; }
  }
  assert.ok(caught > 0, '변이(가림막 원판이 렌더보다 큼)를 어느 시점에서도 잡지 못함');
});

// ---- 격자 경계 장면(F-133④) -----------------------------------------------------------------
// 64×64 화면, 피라미드 크기 64(COVER_PYRAMID_SIZE·occlusion 기본) → 블록·0 단계 칸이 모두 1×1 픽셀이다.
// 카메라 R = I, t = 0, fx = fy = 64, 주점 (cx, cy) 는 정수. 점 두 개(maxLeafPoints 1 → 리프 2개):
//   가림막 O = (0, 0, zo), 법선 (0,0,−1)(카메라 쪽 = 앞면). 화면 위 중심은 픽셀 모서리 (cx, cy), 원판 반경 r = fx·s/(2·zo).
//   뒤 점 F = (0, 0, zf), 법선 (0,0,+1)(등짐 = 뒷면 후보). 반경 rf = r·zo/zf.
// 판정 사각형: F 리프 상자는 점 하나라 zmin = zf, u = cx. 반경 상한 + 1 px 로 넓히면
//   i0 = floor(cx − rf − 1 − 0.5), i1 = floor(cx + 1 + rf). 0 < rf < 0.5 이면 i0 = cx − 2, i1 = cx + 1(행도 같음)
//   → 4×4 픽셀 [cx−2, cx+1]². 그 칸이 모두 O(깊이 zo < zf)로 '확실히 덮여야' F 를 버린다.
// 1×1 블록은 픽셀 중심이 원판 안이어야 덮인다. 사각형에서 가장 먼 픽셀 중심은 네 모서리 칸 (cx ± 1.5, cy ± 1.5),
//   거리 R* = 1.5·√2. 그래서 r < R* 이면 모서리 4칸이 비어 F 를 남기고(제거 0), r ≥ R* 이면 16칸이 덮여 F 를 버린다(제거 1).
// 점 지름 s = 2·zo·r/fx 를 r = R*·(1 ∓ GAP_REL) 로 정한다. 덮임 판정 반경이 ×1.01 이 되면 (1 − GAP_REL)·1.01 > 1 이라
//   '남김' 장면이 '제거' 로 바뀐다(시드와 무관하게 결정적). 참조 래스터도 같은 규칙(중심 거리 ≤ r)이라
//   O 만 그린 렌더에서 4×4 안 덮인 픽셀은 남김 장면 12, 제거 장면 16 이다.
// 시드마다 cx, cy ∈ [4, 59], zo ∈ [1, 2), zf ∈ [10, 20) 를 고른다 → rf ≤ R*·1.01·2/10 < 0.5(사각형 4×4 유지).
const GAP_SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const GAP_REL = 0.004;
const GAP_SIZE = 64, GAP_FX = 64;
const R_STAR = 1.5 * Math.SQRT2;
const GAP_FAR_LEAF_REMOVED = { keep: 0, remove: 1 }; // 단계마다 F 리프 제거 수
const GAP_BLOCK_COVERED = { keep: 12, remove: 16 }; // O 만 그린 참조 렌더에서 [cx−2, cx+1]² 안 덮인 픽셀 수

function gapScene(seed, side) {
  const rnd = mulberry32(seed);
  const cx = 4 + Math.floor(rnd() * 56), cy = 4 + Math.floor(rnd() * 56);
  const zo = Math.fround(1 + rnd()), zf = Math.fround(10 + 10 * rnd());
  const cloud = {
    format: 1, count: 2,
    positions: new Float32Array([0, 0, zo, 0, 0, zf]),
    normals: new Float32Array([0, 0, -1, 0, 0, 1]),
    colors: new Uint8Array([255, 0, 0, 0, 0, 255]),
  };
  const h = buildHierarchy(cloud, { edge0M: 0.01, levelCount: 1, maxLeafPoints: 1 });
  const cam = { width: GAP_SIZE, height: GAP_SIZE, K: { fx: GAP_FX, fy: GAP_FX, cx, cy }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  const r = R_STAR * (side === 'keep' ? 1 - GAP_REL : 1 + GAP_REL);
  const s = (2 * zo * r) / GAP_FX;
  return { cloud, h, cam, cx, cy, zo, zf, r, s };
}

/** 결합 경로로 한 단계만 돌려 그 단계의 제거 수를 돌려준다. */
function gapRemoved(sc, stage, stageImpls) {
  const res = cullAndSelect(sc.h, sc.cam, { thresholdPx: TAU, stages: [stage], pointSizeM: sc.s, stageImpls, orderChunks: defaults.orderChunks, isDegenerateView: defaults.isDegenerateView });
  return stage === 'occlusion' ? res.cull.stats.removedOcclusion : res.cull.stats.removedBackface;
}

/** (d) 고정값 검사. 어기면 던진다(변이 자기 점검이 같은 함수를 쓴다). */
function checkGap(seed, stage, stageImpls) {
  for (const side of ['keep', 'remove']) {
    const got = gapRemoved(gapScene(seed, side), stage, stageImpls);
    assert.equal(got, GAP_FAR_LEAF_REMOVED[side], `시드 ${seed} ${stage} ${side}: 제거 ${got}`);
  }
}

test('F-133④ 격자 경계 장면 설계: 리프 2개, 판정 사각형 4×4, 참조 렌더 덮임 12/16, rf < 0.5', () => {
  for (const seed of GAP_SEEDS) {
    for (const side of ['keep', 'remove']) {
      const sc = gapScene(seed, side);
      assert.equal(sc.h.octree.leafCount, 2, `시드 ${seed}`);
      const rf = (sc.r * 1.01 * sc.zo) / sc.zf;
      assert.ok(rf > 0 && rf < 0.5, `시드 ${seed}: rf ${rf}`);
      const ren = renderPoints(sc.cam, { ...sc.cloud, count: 1, positions: sc.cloud.positions.subarray(0, 3), normals: sc.cloud.normals.subarray(0, 3), colors: sc.cloud.colors.subarray(0, 3) }, { pointSizeM: sc.s });
      let covered = 0;
      for (let j = sc.cy - 2; j <= sc.cy + 1; j++) for (let i = sc.cx - 2; i <= sc.cx + 1; i++) if (ren.index[j * GAP_SIZE + i] === 0) covered++;
      assert.equal(covered, GAP_BLOCK_COVERED[side], `시드 ${seed} ${side}: 덮인 픽셀 ${covered}`);
    }
  }
});

for (const stage of ['occlusion', 'backface']) {
  test(`F-133④ 격자 경계 장면 ${stage}: 시드 1..12 모두 r = R*·(1−${GAP_REL}) 이면 제거 0, R*·(1+${GAP_REL}) 이면 제거 1`, () => {
    const failed = [];
    for (const seed of GAP_SEEDS) {
      try { checkGap(seed, stage, defaults.stageImpls); } catch (e) { failed.push(e.message.split('\n')[0]); }
    }
    assert.deepEqual(failed, [], `고정값을 어긴 시드 ${failed.length}/${GAP_SEEDS.length}: ${failed.join('; ')}`);
  });
}

test('F-133④ 변이 자기 점검: 가림 피라미드 원판 지름 ×1.01 이면 시드 1..12 모두 격자 경계 고정값이 깨진다', () => {
  const mutated = {
    ...defaults.stageImpls,
    occlusion: (h, cam, o) => occlusionCull(h, cam, buildDepthPyramid(h, cam, { pointSizeM: o.pointSizeM * 1.01 })),
  };
  for (const seed of GAP_SEEDS) assert.throws(() => checkGap(seed, 'occlusion', mutated), /keep: 제거 1/, `시드 ${seed}`);
});
