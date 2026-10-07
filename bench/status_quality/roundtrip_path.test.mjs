// SSIM 경로의 조각 왕복이 송출 경로(packCloudPieces: sceneToEnu 뒤 ENU 타일·maxPoints)와 같은 조각을 쓰는지 잠그는 시험.
// SSIM 은 시점별 LOD 선택분을 재는 것이며 원본 점 전부 송출과는 별개다. 작은 장면(2 만 점·8시점)으로 빠르게 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';
import { ssim } from '../../server/metrics/ssim/index.mjs';
import { buildHierarchy, materialize } from '../../server/lod/select/index.mjs';
import { cullAndSelectDefault } from '../../server/cull/combine/index.mjs';
import { packCloudPieces } from '../proto/measure.mjs';
import { W, H, TAU, POINT_SIZE_M, LEVEL_COUNT, MAX_LEAF, EDGE0_M, VIEWPOINTS, chunkedRoundTrip } from './index.mjs';

const COUNT = 20000;

async function measure(onDecoded) {
  const { cloud } = generate({ seed: 1, count: COUNT });
  const h = buildHierarchy(cloud, { edge0M: EDGE0_M, levelCount: LEVEL_COUNT, maxLeafPoints: MAX_LEAF });
  const rows = [];
  for (const vp of VIEWPOINTS) {
    const cam = viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov_y_deg });
    const r = await cullAndSelectDefault(h, cam, { thresholdPx: TAU, pointSizeM: POINT_SIZE_M });
    const sel = materialize(h, r.selection);
    const rt = chunkedRoundTrip(sel, { onDecoded });
    // 기준 = 같은 선택 점군을 왕복 없이 그린 것(코덱·조각 경로 손실만 본다).
    const a = renderPoints(cam, sel, { pointSizeM: POINT_SIZE_M });
    const b = renderPoints(cam, rt.cloud, { pointSizeM: POINT_SIZE_M });
    rows.push({ vp: vp.name, ssim: ssim(a.color, b.color, W, H, 3), chunks: rt.chunks, expectChunks: packCloudPieces(sel, { segmentId: 1, level: 0 }).length, sel, rt });
  }
  return rows;
}

test('왕복 조각 수·점 수가 packCloudPieces 와 같고 SSIM 이 0.99 이상이다', async () => {
  const rows = await measure();
  assert.equal(rows.length, 8);
  for (const r of rows) {
    assert.equal(r.chunks, r.expectChunks, `${r.vp}: 조각 수`);
    assert.equal(r.rt.cloud.count, r.sel.count, `${r.vp}: 점 수`);
    assert.ok(r.ssim >= 0.99, `${r.vp}: SSIM ${r.ssim}`);
  }
});

test('변이: 복호 색 r 평면을 0 으로 깨면 같은 문턱이 실패한다', async () => {
  const rows = await measure((planes) => planes.color_r.fill(0));
  assert.ok(rows.some((r) => r.ssim < 0.99), `변이 최소 SSIM ${Math.min(...rows.map((r) => r.ssim))}`);
});
