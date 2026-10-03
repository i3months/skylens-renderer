// F-120: 퇴화 시점 판정 통일. 같은 퇴화 카메라 목록에서 frustum/priority/client/degenerate 의 모든 공개 함수가 같은 판정(빈 결과)을 낸다.
// 그리고 정상 카메라(큰 해상도 포함)는 모든 경로에서 퇴화가 아니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';
import { isDegenerateView } from '../../server/cull/degenerate/index.mjs';
import { frustumCull, isDegenerateViewLocal } from '../../server/cull/frustum/index.mjs';
import { leafPriority, orderChunks } from '../../server/cull/priority/index.mjs';
import { clientFrustumCull, leafBoxesOf, isDegenerateViewClient } from './index.mjs';

const { cloud } = generate({ seed: 1, count: 3000 });
const hier = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 256 });
const boxes = leafBoxesOf(hier.octree);
const good = (over = {}) => ({ ...viewpointToCamera({ eye: [0, 120, 140], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 }), ...over });
const base = good();
const withK = (k, over = {}) => ({ ...base, K: { ...base.K, ...k }, ...over });

const DEGENERATE = {
  'width 1 + fx 1e7 (시야각 < 1e-6)': withK({ fx: 1e7 }, { width: 1 }),
  'height 1 + fy 1e7': withK({ fy: 1e7 }, { height: 1 }),
  'R = 2I': good({ R: [2, 0, 0, 0, 2, 0, 0, 0, 2] }),
  'reflection R (det -1)': good({ R: [-1, 0, 0, 0, 1, 0, 0, 0, 1] }),
  'R = 0': good({ R: new Array(9).fill(0) }),
  'resolution 2e9': good({ width: 2e9, height: 2e9 }),
  'resolution 2e9 x 1': good({ width: 2e9, height: 1 }),
  'NaN t': good({ t: [NaN, 0, 0] }),
  'fx 0': withK({ fx: 0 }),
  'camera null': null,
};

const all = (cam) => ({
  degenerate: isDegenerateView(cam),
  local: isDegenerateViewLocal(cam),
  client: isDegenerateViewClient(cam),
});

for (const [name, cam] of Object.entries(DEGENERATE)) {
  test(`F-120 퇴화 통일: ${name} -> 모든 공개 함수가 같은 판정(빈 결과, 던지지 않음)`, () => {
    assert.deepEqual(all(cam), { degenerate: true, local: true, client: true });
    const n = hier.octree.leafCount;
    assert.equal(frustumCull(hier, cam).length, n);
    assert.ok(frustumCull(hier, cam).every((v) => v === 0));
    assert.ok(frustumCull(hier, cam, { pointSizeM: 0.1 }).every((v) => v === 0));
    assert.ok(clientFrustumCull(boxes, cam).every((v) => v === 0));
    assert.ok(clientFrustumCull(boxes, cam, { pointSizeM: 0.1 }).every((v) => v === 0));
    const score = leafPriority(hier, cam);
    assert.equal(score.length, n);
    assert.ok(score.every((v) => v === 0));
    assert.equal(orderChunks(hier, cam, new Uint8Array(n).fill(1)).length, 0);
  });
}

test('F-120 정상 카메라(큰 해상도 포함)는 모든 판정에서 퇴화가 아니고 같은 마스크를 낸다', () => {
  for (const cam of [good(), good({ width: 4000, height: 3000, K: { ...base.K, fx: base.K.fx * 60, fy: base.K.fy * 60, cx: 2000, cy: 1500 } })]) {
    assert.deepEqual(all(cam), { degenerate: false, local: false, client: false });
    assert.deepEqual([...clientFrustumCull(boxes, cam, { pointSizeM: 0.2 })], [...frustumCull(hier, cam, { pointSizeM: 0.2 })]);
  }
});

test('F-120 priority: 60000x60000 해상도도 느리지 않고 던지지 않는다(거친 버퍼 칸 수 상한)', () => {
  const cam = good({ width: 60000, height: 60000, K: { ...base.K, fx: base.K.fx * 1000, fy: base.K.fy * 1000, cx: 30000, cy: 30000 } });
  assert.equal(isDegenerateView(cam), false);
  const t0 = performance.now();
  const score = leafPriority(hier, cam);
  const order = orderChunks(hier, cam, new Uint8Array(hier.octree.leafCount).fill(1));
  const ms = performance.now() - t0;
  assert.equal(score.length, hier.octree.leafCount);
  assert.equal(order.length, hier.octree.leafCount);
  assert.ok(ms < 5000, `60000x60000 우선순위 ${ms.toFixed(0)} ms`);
});

test('F-122 ⑥: leafBoxesOf 는 짧은 boxMin/boxMax 를 거부한다', () => {
  const oc = hier.octree;
  assert.throws(() => leafBoxesOf({ ...oc, boxMin: oc.boxMin.subarray(0, oc.boxMin.length - 3) }), /^Error: cull:/);
  assert.throws(() => leafBoxesOf({ ...oc, boxMax: new Float32Array(0) }), /^Error: cull:/);
});
