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
import { predictiveMask, predictCamera } from './predict/index.mjs';
import { leafPriority, orderChunks } from './priority/index.mjs';
import { cullAndSelect, cullAndSelectDefault } from './combine/index.mjs';
import { clientFrustumCull, leafBoxesOf } from '../../client/cull/index.mjs';
import { isDegenerateView } from './degenerate/index.mjs';

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
  'R 구멍': good({ R: [1, , 0, 0, 1, 0, 0, 0, 1] }),
  "width '640'": good({ width: '640' }),
  't 길이 2': good({ t: [0, 0] }),
  't Float32Array 6개': good({ t: new Float32Array(6) }),
  't 구멍': good({ t: [0, , 0] }),
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
  predictCamera: (c) => predictCamera(c, { velocityMps: [1, 0, 0], angularRadPerS: [0, 0, 0] }, 1),
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
      if (stage === 'predictCamera') { // 마스크가 아니라 카메라: NaN 이 그대로 퍼진다(던지지 않음)
        assert.ok(r && typeof r === 'object' && Array.isArray(r.R) && r.R.length === 9);
        assert.equal(isDegenerateView(r), true);
        return;
      }
      if (stage === 'buildDepthPyramid') { // 빈 피라미드: 퇴화 표지·크기 0·모든 깊이 Infinity
        assert.equal(r.degenerate, true);
        assert.equal(r.width, 0);
        assert.equal(r.height, 0);
        assert.equal(r.occluderPoints, 0);
        assert.ok(r.levels.length > 0 && r.levels.every((l) => l.every((v) => v === Infinity)), '빈 피라미드는 모든 깊이가 Infinity'); // 가릴 것이 없다
        return;
      }
      if (stage === 'leafPriority') {
        // leafPriority 반환값: Float64Array, 퇴화 시점에서는 모두 0
        assert.ok(r instanceof Float64Array, `leafPriority 반환값은 Float64Array 여야 함`);
        assert.equal(r.length, n, `leafPriority 길이는 ${n} 여야 함`);
        assert.ok(Array.from(r).every((v) => v === 0), `leafPriority 는 모두 0 이어야 함`);
        return;
      }
      if (stage === 'orderChunks') {
        // orderChunks 반환값: Uint32Array, 퇴화 시점에서는 빔
        assert.ok(r instanceof Uint32Array, `orderChunks 반환값은 Uint32Array 여야 함`);
        assert.equal(r.length, 0, `orderChunks 는 빈 배열이어야 함`);
        return;
      }
      assert.equal(arr.length, n);
      assert.ok(arr.every((v) => v === 0), `${stage} 가 비어 있지 않음`);
    });
  }
}
