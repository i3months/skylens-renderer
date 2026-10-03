// T08.8 통합 시험: 실제 단계 모듈(CULL_API 의 degenerate·frustum·backface·occlusion·distance·priority)을 동적으로 읽어
// cullAndSelectDefault 로 결합 선택을 돌린다. 병렬 개발 중 모듈이 하나라도 없으면 전체를 skip 한다(import 시도로 확인).
// 단언: 시점 8곳(flat_boxes, synthetic.json) SSIM ≥ 0.95, 마스크 0 리프 NOT_DRAWN·마스크 1 리프 단계 동일, 점 수 비증가,
//       prioritize 결과가 남은 리프의 순열, NaN 카메라 → 빈 선택.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CULL_API } from '../../../contracts/cull/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';

const NEEDED = ['degenerate', 'frustum', 'backface', 'occlusion', 'distance', 'priority'];
const missing = [];
for (const k of NEEDED) {
  try {
    await import(new URL(`../../../${CULL_API[k].module}`, import.meta.url).href);
  } catch (e) {
    // 그 모듈(또는 그 모듈이 읽는 다른 server/cull 모듈)이 아직 없을 때만 skip.
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('server/cull/')) missing.push(k);
    else throw e; // 모듈은 있으나 읽다가 깨지면 숨기지 않는다
  }
}
const skip = missing.length ? `단계 모듈 없음: ${missing.join(', ')}` : false;

const SSIM_MIN = 0.95;
const W = 320, H = 180, TAU = 0.5, POINT_SIZE_M = 0.75;

test('통합: 실제 단계 모듈로 결합 선택(시점 8곳 SSIM·단계 동일·점 수 비증가)', { skip }, async (t) => {
  const { generate } = await import('../../../fixtures/scenes/flat_boxes/index.mjs');
  const { viewpointToCamera } = await import('../../../tools/render_views/index.mjs');
  const { renderPoints } = await import('../../raster_ref/zbuffer/index.mjs');
  const { ssim } = await import('../../metrics/ssim/index.mjs');
  const { buildHierarchy, selectLevels, materialize } = await import('../../lod/select/index.mjs');
  const { cullAndSelectDefault, loadDefaultStages } = await import('./index.mjs');

  const stageImpls = await loadDefaultStages();
  assert.deepEqual(Object.keys(stageImpls).sort(), ['backface', 'distance', 'frustum', 'occlusion']);

  const { cloud } = generate({ seed: 1, count: 200000 });
  const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 6, maxLeafPoints: 2048 });
  const vps = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
  assert.equal(vps.length, 8);
  for (const vp of vps) {
    const cam = viewpointToCamera({ ...vp, width: W, height: H });
    const lod = selectLevels(h, cam, { thresholdPx: TAU });
    const r = await cullAndSelectDefault(h, cam, { thresholdPx: TAU, maxDistanceM: 10000, pointSizeM: POINT_SIZE_M, prioritize: true });
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
