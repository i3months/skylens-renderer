// F-153: leafIndex 가 Int32Array 가 아니거나(Float32Array) 정수가 아닌 값(1.5)을 가져도 'cull:' 오류로 거부한다.
// F-150: leafIndex 중복(리프 누락 동반)·리프 노드 상자의 ±Infinity 를 모든 컬링 단계가 'cull:' 오류로 거부한다.
// 표 = 단계 6개(frustum·distance·predict·occlusion·priority·clientFrustumCull) × 입력 5종. 양성 대조로 정상 계층은 던지지 않음을 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { frustumCull } from '../frustum/index.mjs';
import { distanceCull } from '../distance/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../occlusion/index.mjs';
import { predictiveMask } from '../predict/index.mjs';
import { leafPriority } from '../priority/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { leafBoxesOf, clientFrustumCull } from '../../../client/cull/index.mjs';

const CULL = /^Error: cull:/;
const good = () => ({ width: 64, height: 48, K: { fx: 100, fy: 100, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const { cloud } = generate({ seed: 1, count: 2000 });
const healthy = () => buildHierarchy(cloud, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 64 });
const state = () => ({ camera: good(), velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] });
const PRED = { horizonS: 1, steps: 2, pointSizeM: 0.1 };
const okPyr = buildDepthPyramid(healthy(), good());

// 리프 노드 번호 목록(leafIndex >= 0).
const leafNodes = (oc) => {
  const out = [];
  for (let n = 0; n < oc.nodeCount; n++) if (oc.leafIndex[n] >= 0) out.push(n);
  return out;
};

// 입력 종류: 정상 계층을 복사해 한 곳만 망가뜨린다(typed array 는 복사본이라 원본·다른 케이스에 영향 없음).
const withOctree = (h, patch) => ({ ...h, octree: { ...h.octree, ...patch } });
const CASES = [
  ['leafIndex 중복(리프 누락)', (h) => {
    const oc = h.octree, li = Int32Array.from(oc.leafIndex), [a, b] = leafNodes(oc);
    li[b] = li[a]; // 두 노드가 같은 리프 번호를 가리켜 b 의 번호가 비게 된다
    return withOctree(h, { leafIndex: li });
  }],
  ['boxMin = -Infinity', (h) => {
    const mn = Float32Array.from(h.octree.boxMin);
    mn[3 * leafNodes(h.octree)[0]] = -Infinity;
    return withOctree(h, { boxMin: mn });
  }],
  ['boxMax = +Infinity', (h) => {
    const mx = Float32Array.from(h.octree.boxMax);
    mx[3 * leafNodes(h.octree)[0] + 1] = Infinity;
    return withOctree(h, { boxMax: mx });
  }],
  // Int32Array 는 1.5 를 담을 수 없으므로 비정수 값은 Float32Array leafIndex 로만 만들 수 있다.
  ['비정수 leafIndex (Float32Array, 1.5)', (h) => {
    const oc = h.octree, li = Float32Array.from(oc.leafIndex);
    li[leafNodes(oc)[0]] = 1.5;
    return withOctree(h, { leafIndex: li });
  }],
  ['Float32Array leafIndex (값은 모두 정수)', (h) => withOctree(h, { leafIndex: Float32Array.from(h.octree.leafIndex) })],
];

const STAGES = [
  ['frustumCull', (h) => frustumCull(h, good())],
  ['distanceCull', (h) => distanceCull(h, good(), { maxDistanceM: 100 })],
  ['predictiveMask', (h) => predictiveMask(h, state(), PRED)],
  ['occlusionCull', (h) => occlusionCull(h, good(), okPyr)],
  ['leafPriority', (h) => leafPriority(h, good())],
  ['clientFrustumCull', (h) => clientFrustumCull(leafBoxesOf(h.octree), good(), { pointSizeM: 0.1 })],
];

for (const [stage, run] of STAGES) {
  for (const [input, make] of CASES) {
    test(`${stage} × ${input}: cull: 오류`, () => {
      const bad = make(healthy());
      assert.throws(() => run(bad), (e) => e instanceof Error && !(e instanceof TypeError) && CULL.test(String(e)), `${stage} 가 'cull:' 오류를 던지지 않음`);
    });
  }
}

// ---- 양성 대조 ----------------------------------------------------------------------------------
for (const [stage, run] of STAGES) {
  test(`양성 대조: ${stage} 는 정상 계층에서 던지지 않음`, () => {
    assert.doesNotThrow(() => run(healthy()));
  });
}

// 같은 방식으로 만든 두 정상 계층에서 predictiveMask 결과가 같다(검사 추가가 정상 입력의 결과를 바꾸지 않음).
test('양성 대조: predictiveMask 는 동일하게 만든 계층에서 같은 마스크', () => {
  const a = predictiveMask(healthy(), state(), PRED);
  const b = predictiveMask(healthy(), state(), PRED);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.ok(a.some((v) => v === 1), '정상 입력에서 남는 리프가 하나도 없음');
});
