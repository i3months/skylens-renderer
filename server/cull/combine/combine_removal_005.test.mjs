// F-125②: 렌더 기본 점 크기 pointSizeM 0.05 m 에서 뒷면·가림 제거가 실제로 일어나는 시점을 두고 결합 경로를 시험한다.
//
// 왜 축소 장면인가(측정):
//   combine_quality.test.mjs 의 F-125② 단언(flat_boxes·terrain 원래 크기, 320×180)은 0.05 m 원판이 화면에서 1 px 안팎이라
//   가림막 블록을 '확실히 덮는' 점이 없어 16 시점 모두 뒷면·가림 제거 0 이다(LOD 만 잰다).
//   flat_boxes 원래 크기는 1280×720(시점 파일의 해상도)·maxLeafPoints 256 으로 올려도 8 시점 모두 0 이다.
//   장면과 시점을 같은 배율로 줄이면 화면 위 기하는 그대로이고 원판만 상대적으로 커진다(배율 1/k 축소 = 원래 장면에서 점 지름 0.05·k m).
//   flat_boxes 시드 1·점 20만·320×180·maxLeafPoints 256 에서 잰 뒷면+가림 제거 리프 수(시점 1..8):
//     배율 1/15(= 0.75 m 상당): 0·0·0·29·66·0·0·0      배율 1/30(= 1.5 m 상당): 2·155·0·512·420·73·293·609
//   그래서 배율 1/30 을 쓴다(200 m 바닥 → 6.67 m, 점 간격 약 1.5 cm). top_down 은 지붕·바닥만 보이는 정면 시점이라 0 이다.
//
// 단언(기준값은 리터럴, 사후에 낮추지 않는다):
//   (a) REMOVAL_VIEWS 의 시점마다 뒷면+가림 제거 리프 수 ≥ MIN_REMOVED(1). 8 시점 합으로 뒷면 ≥ 1, 가림 ≥ 1.
//       MIN_REMOVED 는 측정 전에 정한 값이다('제거 > 0'). REMOVAL_VIEWS 는 위 측정으로 고른 시점이다.
//   (b) 픽셀 동일(F-117): 원본 전체 렌더에서 '제거된 리프의 점'이 이긴 픽셀 수 = 0, 그리고 원본 전체 렌더와
//       남은 리프의 원본 점(단계 0, 순서 유지)만 그린 렌더의 깊이·색·빈 픽셀이 모든 픽셀에서 같다(다른 픽셀 0).
//       가림막 원판 지름이 렌더 지름보다 크면 이 보장이 깨진다 → 아래 변이 시험이 그것을 잡는지 본다.
//   (c) 8 시점 모두 SSIM(원본 전체 렌더, 결합 선택 materialize 렌더) ≥ 0.95(계약 COMBINE_MIN_SSIM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate as genFlat } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { ssim } from '../../metrics/ssim/index.mjs';
import { COMBINE_MIN_SSIM } from '../../../contracts/cull/index.mjs';
import { buildHierarchy, materialize } from '../../lod/select/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../occlusion/index.mjs';
import { cullAndSelect, loadDefaultImpls } from './index.mjs';

const SSIM_MIN = 0.95;
const MIN_REMOVED = 1; // 측정 전에 정함: 시점마다 뒷면+가림 제거 > 0
const POINT_SIZE_M = 0.05; // 렌더 기본 점 지름
const SCALE = 1 / 30;
const W = 320, H = 180, TAU = 0.5, LEVEL_COUNT = 6, MAX_LEAF = 256;
const EDGE0_M = 0.5 * SCALE; // combine_quality 의 flat_boxes edge0M 0.5 를 같은 배율로 줄임
const STAGES = ['frustum', 'backface', 'occlusion', 'distance'];
// 측정으로 고른 시점(뒷면+가림 제거 > 0). top_down 은 0 이라 (a) 에서 뺀다((b)(c) 는 8 시점 모두).
const REMOVAL_VIEWS = ['aerial_overview', 'aerial_oblique_ne', 'street_level', 'low_close_box', 'tower_high', 'tower_mid', 'edge_far'];
// 변이: 가림 피라미드의 원판 지름을 렌더 지름의 이 배수로 키운다.
const MUT_FACTOR = 2;

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
  scene = { cloud, h, leafOf };
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

/** 한 시점: 결합 선택(stageImpls), 원본 전체 렌더, 남은 리프 렌더, LOD 렌더를 재서 행 하나를 돌려준다. */
function measureView(vp, stageImpls, d) {
  const { cloud, h, leafOf } = getScene();
  const cam = viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov });
  const r = cullAndSelect(h, cam, { thresholdPx: TAU, stages: STAGES, pointSizeM: POINT_SIZE_M, stageImpls, orderChunks: d.orderChunks, isDegenerateView: d.isDegenerateView });
  const { mask, stats } = r.cull;
  const full = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M });
  let winners = 0;
  for (const p of full.index) if (p >= 0 && mask[leafOf[p]] === 0) winners++;
  const kept = renderPoints(cam, keptCloud(cloud, leafOf, mask), { pointSizeM: POINT_SIZE_M });
  const sel = renderPoints(cam, materialize(h, r.selection), { pointSizeM: POINT_SIZE_M });
  return {
    vp: vp.name, stats, removedBO: stats.removedBackface + stats.removedOcclusion,
    winners, diff: diffPixels(full, kept), ssim: ssim(full.color, sel.color, W, H, 3),
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
  for (const vp of VPS.filter((v) => REMOVAL_VIEWS.includes(v.name))) {
    const row = measureView(vp, mutated, defaults);
    t.diagnostic(`변이 ${line(row)}`);
    try { checkPixelIdentical(row); } catch { caught++; }
  }
  assert.ok(caught > 0, '변이(가림막 원판이 렌더보다 큼)를 어느 시점에서도 잡지 못함');
});
