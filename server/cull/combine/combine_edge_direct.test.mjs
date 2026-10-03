// F-126 반례를 cullAndSelect 로 직접 단언한다(F-129 ⑥).
// 960×540, 깊이 1 m, u = −1(화면 왼쪽 가장자리 바깥, 원판 반경 18.858 px 안)의 점 하나.
// pointSizeM 을 주면 원판이 화면에 걸치므로 리프가 남고(참조 래스터도 픽셀을 그린다), 없으면 원판 중심 규칙이라 NOT_DRAWN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { cullAndSelect, loadDefaultImpls } from './index.mjs';

const W = 960, H = 540, SIZE_M = 0.05, TAU = 1;
const CAM = { width: W, height: H, K: { fx: 754.32, fy: 753.85, cx: 480, cy: 270 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const unproject = (u, v, d) => [((u - CAM.K.cx) * d) / CAM.K.fx, ((v - CAM.K.cy) * d) / CAM.K.fy, d];

function onePointHierarchy(p) {
  const positions = Float32Array.from(p);
  const cloud = { format: 1, count: 1, positions, normals: Float32Array.from([0, 0, -1]), colors: Uint8Array.from([200, 200, 200]) };
  const one = () => Uint32Array.from([0, 1]);
  return {
    cloud,
    edge0M: 0.05,
    octree: {
      nodeCount: 1, leafCount: 1, firstChild: Int32Array.from([-1]), childCount: new Uint8Array(1), leafIndex: Int32Array.from([0]),
      boxMin: positions.slice(), boxMax: positions.slice(), leafStart: one(), order: Uint32Array.from([0]),
    },
    levels: [{ level: 0, edgeM: 0.05, count: 1, indices: Uint32Array.from([0]), leafStart: one(), positions: positions.slice(), normals: cloud.normals.slice(), colors: cloud.colors.slice() }],
  };
}

test('가장자리 반례: 래스터가 픽셀을 그리고, cullAndSelect 는 pointSizeM 을 주면 남기고 없으면 NOT_DRAWN', async () => {
  const h = onePointHierarchy(unproject(-1, H / 2, 1));
  const res = renderPoints(CAM, h.cloud, { pointSizeM: SIZE_M });
  let px = 0;
  for (let i = 0; i < res.index.length; i++) if (res.index[i] >= 0) px++;
  assert.ok(px >= 1, `참조 래스터 픽셀 ${px}`);

  const d = await loadDefaultImpls();
  const base = { thresholdPx: TAU, stageImpls: d.stageImpls, orderChunks: d.orderChunks, isDegenerateView: d.isDegenerateView };
  for (const stages of [undefined, ['frustum'], ['frustum', 'backface', 'occlusion']]) {
    const extra = stages ? { stages } : {};
    const withSize = cullAndSelect(h, CAM, { ...base, ...extra, pointSizeM: SIZE_M });
    assert.notEqual(withSize.selection.leafLevel[0], NOT_DRAWN, `pointSizeM 있음 ${JSON.stringify(stages)}`);
    assert.equal(withSize.selection.pointCount, 1);
    const without = cullAndSelect(h, CAM, { ...base, ...extra });
    assert.equal(without.selection.leafLevel[0], NOT_DRAWN, `pointSizeM 없음 ${JSON.stringify(stages)}`);
    assert.equal(without.selection.pointCount, 0);
  }
});
