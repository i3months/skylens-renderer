// T08.8 결합 선택 화질·점 수 시험. 합성 장면 3종 × 고정 시점 8곳.
// 앞부분: 임시 절두체 단계(tempFrustumStage)와 신탁 가림 단계로 결합 로직 자체를 시험한다.
//   임시 절두체 단계 = 리프 상자에 server/lod/select/view_check.mjs 의 boxMayBeVisible(보수적: 확실히 밖일 때만 0)을 적용한 마스크.
// 뒷부분(F-118①·F-125②): 실제 단계 모듈(frustum·backface·occlusion·distance)을 cullAndSelectDefault 로 통과시켜 같은 SSIM 을 잰다.
// 단언(기준값은 리터럴, 사후에 낮추지 않는다):
//   (a) materialize(결합 선택) 렌더와 원본 전체 렌더의 SSIM ≥ COMBINE_MIN_SSIM(0.95), 시점마다.
//   (b) 남은 리프 수·그린 리프 수·점 수를 LOD 만일 때와 나란히 표로 기록(t.diagnostic).
//   (c) 마스크 0 리프는 NOT_DRAWN, 마스크 1 리프의 단계는 LOD 만일 때와 같다.
//   (d) pointCount ≤ LOD 만일 때의 pointCount.
// 고정 파라미터(근거는 select.test.mjs·select_coarse.test.mjs 와 같다: τ 0.5 는 나이퀴스트 조건, 점 크기는 원본·결합 같은 고정값):
//   flat_boxes 시드 1, 점 20만, edge0M 0.5, 시점 = fixtures/viewpoints/synthetic.json 8곳(화각 50°).
//   terrain    시드 1, 점 20만, edge0M √(40000/200000)/2 ≈ 0.224, 시점 = select_coarse.test.mjs 의 8곳(화각 90°).
//   holes      시드 1, 점 10만, edge0M 0.5(원본 간격 √(40000/100000) ≈ 0.63 m 보다 작게), 시점 = terrain 과 같은 8곳(화각 90°).
//   공통: 320×180, τ 0.5 px, 점 지름 0.75 m, levelCount 6, maxLeafPoints 2048.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate as genFlat } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { generate as genTerrain } from '../../../fixtures/scenes/terrain/index.mjs';
import { generate as genHoles } from '../../../fixtures/scenes/holes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { ssim } from '../../metrics/ssim/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { COMBINE_MIN_SSIM } from '../../../contracts/cull/index.mjs';
import { buildHierarchy, selectLevels, materialize } from '../../lod/select/index.mjs';
import { boxMayBeVisible } from '../../lod/select/view_check.mjs';
import { cullAndSelect, cullAndSelectDefault, loadDefaultImpls } from './index.mjs';

const SSIM_MIN = 0.95;
const W = 320, H = 180, TAU = 0.5, POINT_SIZE_M = 0.75, LEVEL_COUNT = 6, MAX_LEAF = 2048;

const FLAT_VP = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints
  .map((vp) => ({ name: vp.name, eye: vp.eye, target: vp.target, up: vp.up, fov: vp.fov_y_deg }));
const GROUND_VP = [
  { name: 'top_down_150', eye: [0, 150, 0.01], target: [0, 15, 0] },
  { name: 'oblique_sw_120', eye: [-140, 120, -140], target: [0, 15, 0] },
  { name: 'east_90', eye: [140, 90, 0], target: [-20, 15, 0] },
  { name: 'south_60', eye: [0, 60, 140], target: [0, 15, 0] },
  { name: 'low_ne_30', eye: [100, 30, 100], target: [0, 15, -30] },
  { name: 'west_45', eye: [-120, 45, 60], target: [40, 10, -20] },
  { name: 'far_north_150', eye: [60, 150, -160], target: [0, 15, 20] },
  { name: 'inside_100', eye: [-50, 100, -50], target: [50, 10, 50] },
].map((vp) => ({ ...vp, up: [0, 1, 0], fov: 90 }));

const SCENES = [
  { name: 'flat_boxes', gen: () => genFlat({ seed: 1, count: 200000 }), edge0M: 0.5, vps: FLAT_VP },
  { name: 'terrain', gen: () => genTerrain({ seed: 1, count: 200000 }), edge0M: Math.sqrt(40000 / 200000) / 2, vps: GROUND_VP },
  { name: 'holes', gen: () => genHoles({ seed: 1, count: 100000 }), edge0M: 0.5, vps: GROUND_VP },
];

/** 임시 절두체 단계: 리프 상자가 시야 사각뿔 밖임이 확실할 때만 0. */
export function tempFrustumStage(h, cam) {
  const oc = h.octree;
  const out = new Uint8Array(oc.leafCount);
  const mn = [0, 0, 0], mx = [0, 0, 0];
  for (let node = 0; node < oc.nodeCount; node++) {
    const k = oc.leafIndex[node];
    if (k < 0) continue;
    for (let a = 0; a < 3; a++) { mn[a] = oc.boxMin[3 * node + a]; mx[a] = oc.boxMax[3 * node + a]; }
    out[k] = boxMayBeVisible(cam, mn, mx) ? 1 : 0;
  }
  return out;
}

/** 점 → 리프 번호(octree.order·leafStart). */
function pointLeafOf(h) {
  const oc = h.octree;
  const out = new Uint32Array(h.cloud.count);
  for (let k = 0; k < oc.leafCount; k++) for (let i = oc.leafStart[k]; i < oc.leafStart[k + 1]; i++) out[oc.order[i]] = k;
  return out;
}

/**
 * 신탁 가림 단계(시험 전용): 원본 렌더에서 픽셀을 하나라도 차지한 점이 있는 리프만 남긴다.
 * 실제 단계보다 공격적이지만(같은 점 크기의 원본 렌더를 정답으로 씀) 결합이 '절두체 밖이 아닌' 리프를 실제로 빼는 경우를 시험한다.
 */
function oracleStage(origRender, pointLeaf, leafCount) {
  return () => {
    const m = new Uint8Array(leafCount);
    for (const i of origRender.index) if (i >= 0) m[pointLeaf[i]] = 1;
    return m;
  };
}

const drawnLeaves = (sel) => sel.leafLevel.reduce((n, l) => n + (l !== NOT_DRAWN ? 1 : 0), 0);

for (const sc of SCENES) {
  let cached;
  const get = () => {
    if (!cached) {
      const { cloud } = sc.gen();
      const h = buildHierarchy(cloud, { edge0M: sc.edge0M, levelCount: LEVEL_COUNT, maxLeafPoints: MAX_LEAF });
      cached = { cloud, h, pointLeaf: pointLeafOf(h) };
    }
    return cached;
  };
  const minOf = [];
  test(`${sc.name}: 시점 8곳`, () => assert.equal(sc.vps.length, 8));
  for (const vp of sc.vps) {
    test(`결합 선택 SSIM ≥ ${SSIM_MIN}·단계 동일·점 수 비증가: ${sc.name} ${vp.name}`, (t) => {
      const { cloud, h } = get();
      const cam = viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov });
      const lod = selectLevels(h, cam, { thresholdPx: TAU });
      const r = cullAndSelect(h, cam, { thresholdPx: TAU, stages: ['frustum'], stageImpls: { frustum: tempFrustumStage } });
      const { mask } = r.cull;
      // (c)
      for (let k = 0; k < h.octree.leafCount; k++) {
        if (mask[k] === 0) assert.equal(r.selection.leafLevel[k], NOT_DRAWN, `리프 ${k}: 마스크 0 인데 그림`);
        else assert.equal(r.selection.leafLevel[k], lod.leafLevel[k], `리프 ${k}: 단계가 LOD 만일 때와 다름`);
      }
      // (d)
      assert.ok(r.selection.pointCount <= lod.pointCount, `점 수 증가 ${r.selection.pointCount} > ${lod.pointCount}`);
      const pts = materialize(h, r.selection);
      assert.equal(pts.count, r.selection.pointCount);
      // (a)
      const a = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M });
      const b = renderPoints(cam, pts, { pointSizeM: POINT_SIZE_M });
      const s = ssim(a.color, b.color, W, H, 3);
      minOf.push(s);
      // (b)
      t.diagnostic(`| ${sc.name} | ${vp.name} | 리프 ${h.octree.leafCount} | LOD 그린 리프 ${drawnLeaves(lod)} | 결합 조각 ${r.cull.chunks.length} | 결합 그린 리프 ${drawnLeaves(r.selection)} | LOD 점 ${lod.pointCount} | 결합 점 ${r.selection.pointCount} | 원본 점 ${cloud.count} | SSIM ${s.toFixed(4)} | 절두체 제거 ${r.cull.stats.removedFrustum} |`);
      assert.ok(s >= SSIM_MIN, `${sc.name} ${vp.name}: SSIM ${s}`);

      // 추가: 절두체 + 신탁 가림 단계(실제로 더 빼는 경우). (c)(d) 와 SSIM 을 같은 기준으로 본다.
      const r2 = cullAndSelect(h, cam, {
        thresholdPx: TAU, stages: ['frustum', 'occlusion'],
        stageImpls: { frustum: tempFrustumStage, occlusion: oracleStage(a, get().pointLeaf, h.octree.leafCount) },
      });
      for (let k = 0; k < h.octree.leafCount; k++) {
        assert.equal(r2.selection.leafLevel[k], r2.cull.mask[k] ? lod.leafLevel[k] : NOT_DRAWN, `신탁 리프 ${k}`);
      }
      assert.ok(r2.selection.pointCount <= r.selection.pointCount);
      const b2 = renderPoints(cam, materialize(h, r2.selection), { pointSizeM: POINT_SIZE_M });
      const s2 = ssim(a.color, b2.color, W, H, 3);
      t.diagnostic(`| ${sc.name} | ${vp.name} | +신탁 가림 | 조각 ${r2.cull.chunks.length} | 결합 점 ${r2.selection.pointCount} | SSIM ${s2.toFixed(4)} | 가림 제거 ${r2.cull.stats.removedOcclusion} |`);
      assert.ok(s2 >= SSIM_MIN, `${sc.name} ${vp.name} 신탁 가림: SSIM ${s2}`);
    });
  }
  test(`${sc.name}: 시점 8곳 모두 측정·최소 SSIM ≥ ${SSIM_MIN}`, (t) => {
    assert.equal(minOf.length, 8);
    const m = Math.min(...minOf);
    t.diagnostic(`${sc.name} 최소 SSIM ${m.toFixed(4)}`);
    assert.ok(m >= SSIM_MIN);
  });
}

test('시험의 기준값은 계약 COMBINE_MIN_SSIM 과 같다', () => assert.equal(SSIM_MIN, COMBINE_MIN_SSIM));


// ---------------------------------------------------------------------------
// F-118①: 실제 단계 모듈(기본 구현) 통과 시 SSIM ≥ 0.95, 가림 제거 > 0 인 시점이 하나 이상.
// ---------------------------------------------------------------------------
const REAL_STAGES = ['frustum', 'backface', 'occlusion', 'distance'];
const SMALL_POINT_M = 0.05; // F-125②: 기본 렌더 점 크기

/** 한 장면 8 시점을 stageImpls 로 돌려 시점별 {ssim, removedOcclusion, removedAll} 을 돌려준다. pointSizeM 은 결합 경로와 렌더에 같이 쓴다. */
async function measureScene(sc, { pointSizeM, stageImpls, diag }) {
  const { cloud } = sc.gen();
  const h = buildHierarchy(cloud, { edge0M: sc.edge0M, levelCount: LEVEL_COUNT, maxLeafPoints: MAX_LEAF });
  const rows = [];
  for (const vp of sc.vps) {
    const cam = viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov });
    const lod = selectLevels(h, cam, { thresholdPx: TAU, pointSizeM });
    const r = await cullAndSelectDefault(h, cam, { thresholdPx: TAU, stages: REAL_STAGES, pointSizeM, ...(stageImpls ? { stageImpls } : {}) });
    const a = renderPoints(cam, cloud, { pointSizeM });
    const b = renderPoints(cam, materialize(h, r.selection), { pointSizeM });
    const s = ssim(a.color, b.color, W, H, 3);
    const st = r.cull.stats;
    rows.push({ vp: vp.name, ssim: s, removedOcclusion: st.removedOcclusion, removed: st.removedFrustum + st.removedBackface + st.removedOcclusion + st.removedDistance, points: r.selection.pointCount, lodPoints: lod.pointCount, mask: r.cull.mask });
    diag?.(`| ${sc.name} | ${vp.name} | pointSizeM ${pointSizeM} | SSIM ${s.toFixed(4)} | 제거 절두체 ${st.removedFrustum} 후면 ${st.removedBackface} 가림 ${st.removedOcclusion} 거리 ${st.removedDistance} | 점 ${r.selection.pointCount}/${lod.pointCount} |`);
  }
  return rows;
}

/** 시험 기준: 모든 시점 SSIM ≥ 0.95, 점 수 ≤ LOD, (요구 시) 가림 제거 > 0 인 시점 하나 이상. 어기면 던진다. */
function checkRows(name, rows, { needOcclusion }) {
  assert.equal(rows.length, 8, `${name}: 시점 8곳`);
  for (const r of rows) {
    assert.ok(r.ssim >= SSIM_MIN, `${name} ${r.vp}: SSIM ${r.ssim}`);
    assert.ok(r.points <= r.lodPoints, `${name} ${r.vp}: 점 수 증가`);
  }
  if (needOcclusion) assert.ok(rows.some((r) => r.removedOcclusion > 0), `${name}: 가림 제거가 0 인 시점뿐`);
}

const realRows = {}; // 장면 이름 → 행(0.75 m)
for (const sc of SCENES) {
  test(`F-118① 실제 단계 통과 결합 선택(점 ${POINT_SIZE_M} m): ${sc.name} 8곳 SSIM ≥ ${SSIM_MIN}`, async (t) => {
    realRows[sc.name] = await measureScene(sc, { pointSizeM: POINT_SIZE_M, diag: (m) => t.diagnostic(m) });
    // 장면별로는 SSIM·점 수만 요구한다. 가림 제거 > 0 은 아래에서 장면 전체에 대해 요구한다.
    checkRows(sc.name, realRows[sc.name], { needOcclusion: false });
    t.diagnostic(`${sc.name} 최소 SSIM ${Math.min(...realRows[sc.name].map((r) => r.ssim)).toFixed(4)}`);
  });
}

test('F-118① 실제 가림 단계가 3 장면 8 시점 중 하나 이상에서 리프를 제거한다', (t) => {
  assert.equal(Object.keys(realRows).length, SCENES.length, '앞선 측정이 먼저 돌아야 함');
  const all = Object.values(realRows).flat();
  const maxOcc = Math.max(...all.map((r) => r.removedOcclusion));
  t.diagnostic(`가림 제거 최대 ${maxOcc} 리프, 가림 제거 > 0 인 (장면,시점) ${all.filter((r) => r.removedOcclusion > 0).length}/24`);
  assert.ok(maxOcc > 0, '가림 제거 > 0 인 시점 없음');
});

test('F-118① 변이: 단계를 무시하는 구현(전부 1)은 같은 기준을 통과하지 못한다', async () => {
  const d = await loadDefaultImpls();
  const ignoring = Object.fromEntries(Object.keys(d.stageImpls).map((k) => [k, (h) => new Uint8Array(h.octree.leafCount).fill(1)]));
  const sc = SCENES[0];
  const rows = await measureScene(sc, { pointSizeM: POINT_SIZE_M, stageImpls: ignoring });
  assert.ok(rows.every((r) => r.removed === 0), '변이는 아무것도 제거하지 않아야 함');
  // 변이는 SSIM 은 1 이지만 '가림 제거 > 0' 요구를 어긴다 = 단계 무시를 잡는다.
  assert.throws(() => checkRows(`${sc.name}(변이)`, rows, { needOcclusion: true }), /가림 제거가 0/);
  // 같은 기준이 실제 구현에서는 3 장면 전체로 보면 통과한다는 것은 위 시험이 확인한다.
});

// ---------------------------------------------------------------------------
// F-125②: 렌더 점 크기 0.05 m 에서의 SSIM(결합 경로에도 pointSizeM 0.05 를 넘긴다). 앞으로 pointSizeM 이 후면 단계까지
// 전달되어도 같은 단언이 성립한다(보수성은 SSIM 으로만 본다).
// ---------------------------------------------------------------------------
for (const sc of SCENES.slice(0, 2)) {
  test(`F-125② 점 크기 ${SMALL_POINT_M} m: ${sc.name} 8곳 SSIM ≥ ${SSIM_MIN}`, async (t) => {
    const rows = await measureScene(sc, { pointSizeM: SMALL_POINT_M, diag: (m) => t.diagnostic(m) });
    checkRows(`${sc.name}@${SMALL_POINT_M}`, rows, { needOcclusion: false });
    t.diagnostic(`${sc.name}@${SMALL_POINT_M} 최소 SSIM ${Math.min(...rows.map((r) => r.ssim)).toFixed(4)}`);
  });
}
