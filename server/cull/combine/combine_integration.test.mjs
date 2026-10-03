// T08.8 통합 시험: 실제 단계 모듈(CULL_API 의 degenerate·frustum·backface·occlusion·distance·priority)을 동적으로 읽어
// cullAndSelectDefault 로 결합 선택을 돌린다(모든 모듈이 있으므로 skip 분기 없음: 없으면 import 오류로 실패한다).
// 단언: 시점 8곳(flat_boxes, synthetic.json) SSIM ≥ 0.95, 마스크 0 리프 NOT_DRAWN·마스크 1 리프 단계 동일, 점 수 비증가,
//       prioritize 결과가 남은 리프의 순열, NaN 카메라 → 빈 선택.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';

const SSIM_MIN = 0.95;
const W = 320, H = 180, TAU = 0.5, POINT_SIZE_M = 0.75;

test('통합: 실제 단계 모듈로 결합 선택(시점 8곳 SSIM·단계 동일·점 수 비증가)', async (t) => {
  const { generate } = await import('../../../fixtures/scenes/flat_boxes/index.mjs');
  const { viewpointToCamera } = await import('../../../tools/render_views/index.mjs');
  const { renderPoints } = await import('../../raster_ref/zbuffer/index.mjs');
  const { ssim } = await import('../../metrics/ssim/index.mjs');
  const { buildHierarchy, selectLevels, materialize } = await import('../../lod/select/index.mjs');
  const { cullAndSelect, cullAndSelectDefault, loadDefaultStages, loadDefaultImpls } = await import('./index.mjs');

  const stageImpls = await loadDefaultStages();
  assert.deepEqual(Object.keys(stageImpls).sort(), ['backface', 'distance', 'frustum', 'occlusion']);

  const { cloud } = generate({ seed: 1, count: 200000 });
  const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 6, maxLeafPoints: 2048 });
  const vps = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
  assert.equal(vps.length, 8);
  for (const vp of vps) {
    const cam = viewpointToCamera({ ...vp, width: W, height: H });
    const lod = selectLevels(h, cam, { thresholdPx: TAU, pointSizeM: POINT_SIZE_M });
    // 실제 단계 마스크를 기록하는 래퍼: 결합 마스크가 기록된 마스크들의 AND 와 같아야 한다.
    const d = await loadDefaultImpls();
    const rec = {};
    const impls = Object.fromEntries(Object.entries(d.stageImpls).map(([n, f]) => [n, (...a) => (rec[n] = f(...a))]));
    const r = cullAndSelect(h, cam, { thresholdPx: TAU, maxDistanceM: 10000, pointSizeM: POINT_SIZE_M, prioritize: true, stageImpls: impls, orderChunks: d.orderChunks, isDegenerateView: d.isDegenerateView });
    assert.deepEqual(Object.keys(rec).sort(), ['backface', 'distance', 'frustum', 'occlusion']);
    for (let k = 0; k < h.octree.leafCount; k++) {
      const and = rec.frustum[k] & rec.backface[k] & rec.occlusion[k] & rec.distance[k];
      assert.equal(r.cull.mask[k], and, `${vp.name} 마스크 AND 리프 ${k}`);
    }
    if (vp.name === 'low_close_box') {
      // 낮고 평평한 시점: 뒷면·가림 단계가 실제로 일을 한다(측정 전 하한 0: 양수이기만 하면 됨)
      assert.ok(r.cull.stats.removedBackface > 0, `${vp.name} removedBackface ${r.cull.stats.removedBackface}`);
      assert.ok(r.cull.stats.removedOcclusion > 0, `${vp.name} removedOcclusion ${r.cull.stats.removedOcclusion}`);
    }
    // 조각은 NOT_DRAWN 리프를 포함하지 않는다
    for (const k of r.cull.chunks) assert.notEqual(r.selection.leafLevel[k], NOT_DRAWN);
    for (let k = 0; k < h.octree.leafCount; k++) {
      assert.equal(r.selection.leafLevel[k], r.cull.mask[k] ? lod.leafLevel[k] : NOT_DRAWN, `${vp.name} 리프 ${k}`);
    }
    assert.ok(r.selection.pointCount <= lod.pointCount);
    assert.equal(new Set(r.cull.chunks).size, r.cull.chunks.length);
    for (const k of r.cull.chunks) assert.equal(r.cull.mask[k], 1);
    const a = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M });
    const b = renderPoints(cam, materialize(h, r.selection), { pointSizeM: POINT_SIZE_M });
    const s = ssim(a.color, b.color, W, H, 3);
    const st = r.cull.stats;
    t.diagnostic(`${vp.name}: SSIM ${s.toFixed(4)}, 조각 ${r.cull.chunks.length}/${st.leafCount}, 점 ${r.selection.pointCount}/${lod.pointCount}, 제거 F${st.removedFrustum} B${st.removedBackface} O${st.removedOcclusion} D${st.removedDistance}`);
    assert.ok(s >= SSIM_MIN, `${vp.name}: SSIM ${s}`);
  }

  const nan = { ...viewpointToCamera({ ...vps[0], width: W, height: H }), t: [NaN, 0, 0] };
  const e = await cullAndSelectDefault(h, nan, { thresholdPx: TAU });
  assert.equal(e.selection.pointCount, 0);
  assert.ok(e.selection.leafLevel.every((l) => l === NOT_DRAWN));
});

test('F-123: 결합 뒷면 단계가 pointSizeM 을 전달 = 단독 backfaceCull 과 같은 제거·같은 화면', async () => {
  const { generate } = await import('../../../fixtures/scenes/flat_boxes/index.mjs');
  const { viewpointToCamera } = await import('../../../tools/render_views/index.mjs');
  const { renderPoints } = await import('../../raster_ref/zbuffer/index.mjs');
  const { buildHierarchy } = await import('../../lod/select/index.mjs');
  const { leafNormalCones, backfaceCull } = await import('../backface/index.mjs');
  const { cullAndSelectDefault } = await import('./index.mjs');
  const { cloud } = generate({ seed: 1, count: 200000 });
  const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 6, maxLeafPoints: 2048 });
  const vps = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
  const cam = viewpointToCamera({ ...vps.find((v) => v.name === 'low_close_box'), width: W, height: H });
  const alone = backfaceCull(h, cam, leafNormalCones(h), { pointSizeM: POINT_SIZE_M });
  const removedAlone = alone.reduce((n, m) => n + (m === 0 ? 1 : 0), 0);
  assert.ok(removedAlone > 0);
  const r = await cullAndSelectDefault(h, cam, { thresholdPx: TAU, stages: ['backface'], pointSizeM: POINT_SIZE_M });
  assert.equal(r.cull.stats.removedBackface, removedAlone);
  assert.deepEqual([...r.cull.mask], [...alone]);
  // 화면: 두 마스크로 남긴 점의 렌더가 픽셀 단위로 같다(차이 0)
  const oc = h.octree;
  const keep = (m) => {
    const idx = [];
    for (let k = 0; k < oc.leafCount; k++) if (m[k]) for (let i = oc.leafStart[k]; i < oc.leafStart[k + 1]; i++) idx.push(oc.order[i]);
    return { ...cloud, count: idx.length, positions: Float32Array.from(idx.flatMap((i) => [...cloud.positions.subarray(3 * i, 3 * i + 3)])), normals: Float32Array.from(idx.flatMap((i) => [...cloud.normals.subarray(3 * i, 3 * i + 3)])), colors: Uint8Array.from(idx.flatMap((i) => [...cloud.colors.subarray(3 * i, 3 * i + 3)])) };
  };
  const ia = renderPoints(cam, keep(alone), { pointSizeM: POINT_SIZE_M }).color;
  const ib = renderPoints(cam, keep(r.cull.mask), { pointSizeM: POINT_SIZE_M }).color;
  let diff = 0;
  for (let i = 0; i < ia.length; i++) if (ia[i] !== ib[i]) diff++;
  assert.equal(diff, 0);
  // pointSizeM 없음(또는 0): 뒷면 제거 없음
  for (const o of [{}, { pointSizeM: 0 }]) {
    const n = await cullAndSelectDefault(h, cam, { thresholdPx: TAU, stages: ['backface'], ...o });
    assert.equal(n.cull.stats.removedBackface, 0);
  }
});
