// F-132 검증: 카메라 구조 오류는 모든 컬링 단계에서 같은 'cull:' 오류, 값 퇴화는 모든 단계에서 던지지 않고 빈 결과.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { buildHierarchy } from '../lod/hierarchy/index.mjs';
import { frustumCull } from './frustum/index.mjs';
import { backfaceCull, leafNormalCones } from './backface/index.mjs';
import { occlusionCull, buildDepthPyramid } from './occlusion/index.mjs';
import { distanceCull } from './distance/index.mjs';
import { predictiveMask } from './predict/index.mjs';
import { leafPriority, orderChunks } from './priority/index.mjs';
import { cullAndSelect, cullAndSelectDefault } from './combine/index.mjs';
import { clientFrustumCull, leafBoxesOf } from '../../client/cull/index.mjs';

const { cloud } = generate({ seed: 1, count: 3000 });
const hier = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 256 });
const boxes = leafBoxesOf(hier.octree);
const cones = leafNormalCones(hier);
const n = hier.octree.leafCount;
const ones = new Uint8Array(n).fill(1);
const good = (over = {}) => ({ ...viewpointToCamera({ eye: [0, 120, 140], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 }), ...over });
const base = good();
const pyramid = buildDepthPyramid(hier, base); // 정상 카메라로 만든 피라미드(occlusionCull 입구 검사 확인용)

const without = (k) => { const c = good(); delete c[k]; return c; };
const BAD_SHAPE = {
  'camera null': null,
  'width 없음': without('width'),
  'K 없음': without('K'),
  'R Float32Array': good({ R: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }),
  'R 길이 8': good({ R: [1, 0, 0, 0, 1, 0, 0, 0] }),
  "width '640'": good({ width: '640' }),
  't 길이 2': good({ t: [0, 0] }),
};
const BAD_VALUE = {
  'NaN K': good({ K: { ...base.K, fx: NaN } }),
  '8193x8193': good({ width: 8193, height: 8193 }),
  'R = 2I': good({ R: [2, 0, 0, 0, 2, 0, 0, 0, 2] }),
};

const injected = { thresholdPx: 1, stageImpls: {} };
const STAGES = {
  frustumCull: (c) => frustumCull(hier, c, { pointSizeM: 0.1 }),
  backfaceCull: (c) => backfaceCull(hier, c, cones, { pointSizeM: 0.1 }),
  buildDepthPyramid: (c) => buildDepthPyramid(hier, c),
  'occlusionCull(피라미드 없음)': (c) => occlusionCull(hier, c),
  'occlusionCull(피라미드 있음)': (c) => occlusionCull(hier, c, pyramid),
  distanceCull: (c) => distanceCull(hier, c, { maxDistanceM: Infinity }),
  predictiveMask: (c) => predictiveMask(hier, { camera: c, velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] }, { horizonS: 1, steps: 2, pointSizeM: 0.1 }),
  leafPriority: (c) => leafPriority(hier, c),
  orderChunks: (c) => orderChunks(hier, c, ones),
  clientFrustumCull: (c) => clientFrustumCull(boxes, c, { pointSizeM: 0.1 }),
  cullAndSelect: (c) => cullAndSelect(hier, c, { ...injected, stageImpls: { frustum: () => ones, backface: () => ones, occlusion: () => ones, distance: () => ones } }),
  cullAndSelectDefault: (c) => cullAndSelectDefault(hier, c, { thresholdPx: 1, pointSizeM: 0.1 }),
};

// 비동기 함수도 같은 방식으로 다룬다.
const run = async (f, c) => f(c);

for (const [stage, f] of Object.entries(STAGES)) {
  for (const [name, cam] of Object.entries(BAD_SHAPE)) {
    test(`F-132 구조 오류: ${stage} / ${name} -> 'cull:' 오류`, async () => {
      await assert.rejects(run(f, cam), (e) => e instanceof Error && e.message.startsWith('cull:'));
    });
  }
  for (const [name, cam] of Object.entries(BAD_VALUE)) {
    test(`F-132 값 퇴화: ${stage} / ${name} -> 던지지 않고 빈 결과`, async () => {
      const r = await run(f, cam);
      const arr = r?.cull?.mask ?? r;
      if (stage === 'cullAndSelect' || stage === 'cullAndSelectDefault') {
        assert.equal(r.cull.stats.degenerate, true);
        assert.equal(r.selection.pointCount, 0);
      }
      if (stage === 'buildDepthPyramid') return; // 피라미드는 마스크가 아니다: 던지지 않으면 충분
      assert.ok(arr.every((v) => v === 0), `${stage} 가 비어 있지 않음`);
    });
  }
}
