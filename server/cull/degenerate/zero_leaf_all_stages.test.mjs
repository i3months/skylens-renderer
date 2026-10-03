// F-145·F-148 ③: 리프 0 개 계층에서 모든 컬링 단계가 'cull:' 오류를 던진다.
// 고정 계층은 buildHierarchy 가 만든 정상 계층에서 leafCount 만 0(leafStart 길이 1)으로 바꾼 것이다.
// 그래서 각 단계는 점군·leafStart 같은 다른 이유가 아니라 leafCount 때문에만 던진다. leafCount ≥ 1 양성 대조 사례를 함께 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { frustumCull } from '../frustum/index.mjs';
import { distanceCull } from '../distance/index.mjs';
import { leafNormalCones, backfaceCull } from '../backface/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../occlusion/index.mjs';
import { leafPriority, orderChunks } from '../priority/index.mjs';
import { cullAndSelect, loadDefaultImpls } from '../combine/index.mjs';
import { predictiveMask } from '../predict/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { leafBoxesOf } from '../../../client/cull/index.mjs';

const CULL = /^Error: cull:/;

const good = () => ({ width: 64, height: 48, K: { fx: 100, fy: 100, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

const { cloud } = generate({ seed: 1, count: 2000 });
const healthy = () => buildHierarchy(cloud, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 64 });

// 정상 계층에서 leafCount 만 0 으로: 모든 단계의 leafStart 길이 1, 점 배열은 비움(다른 검사가 먼저 걸리지 않게 일관되게 맞춤)
const zeroLeafHierarchy = () => {
  const h = healthy();
  return {
    ...h,
    octree: { ...h.octree, leafCount: 0, leafStart: new Uint32Array(1) },
    levels: h.levels.map((lv) => ({
      ...lv,
      count: 0,
      indices: new Uint32Array(0),
      leafStart: new Uint32Array(1),
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      colors: new Uint8Array(0),
    })),
  };
};

const state = () => ({ camera: good(), velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] });
const PRED = { horizonS: 1, steps: 2, pointSizeM: 0.1 };
const combineOpts = async () => {
  const d = await loadDefaultImpls();
  return { thresholdPx: 1, stageImpls: d.stageImpls, orderChunks: d.orderChunks, isDegenerateView: d.isDegenerateView };
};

// 단계 이름 × 호출. re = 현 구현이 던지는 메시지의 리프·leafCount 문구(각 단계의 검사 메시지에 맞춤).
const STAGES = [
  ['frustumCull', (h) => frustumCull(h, good()), /^Error: cull: octree 배열 길이가 nodeCount·leafCount/],
  ['distanceCull', (h) => distanceCull(h, good(), { maxDistanceM: 100 }), /^Error: cull: octree 배열 길이가 nodeCount·leafCount/],
  ['leafNormalCones', (h) => leafNormalCones(h), /^Error: cull: 계층이 올바르지 않음: lod: 계층의 팔진 트리가 올바르지 않음/],
  ['backfaceCull', (h) => backfaceCull(h, good(), leafNormalCones(healthy())), /^Error: cull: 계층이 올바르지 않음: lod: 계층의 팔진 트리가 올바르지 않음/],
  ['buildDepthPyramid', (h) => buildDepthPyramid(h, good()), /^Error: cull: octree\.nodeCount\/leafCount 가 올바르지 않음/],
  ['occlusionCull', (h) => occlusionCull(h, good(), buildDepthPyramid(healthy(), good())), /^Error: cull: octree\.nodeCount\/leafCount 가 올바르지 않음/],
  ['leafPriority', (h) => leafPriority(h, good()), /^Error: cull: 계층\(octree\)이 올바르지 않음/],
  ['orderChunks', (h) => orderChunks(h, good(), new Uint8Array(0)), /^Error: cull: 계층\(octree\)이 올바르지 않음/],
  ['predictiveMask', (h) => predictiveMask(h, state(), PRED), /^Error: cull: 계층의 팔진 트리가 올바르지 않음/],
  ['leafBoxesOf', (h) => leafBoxesOf(h.octree), /^Error: cull: octree 형식이 올바르지 않음/],
];

for (const [name, run, re] of STAGES) {
  test(`리프 0 개 계층(leafCount 0): ${name} 은 cull: 오류 (리프 문구 확인)`, () => {
    assert.throws(() => run(zeroLeafHierarchy()), (e) => CULL.test(String(e)) && re.test(String(e)), `${name} 메시지가 기대와 다름`);
  });
}

test('리프 0 개 계층(leafCount 0): cullAndSelect 는 cull: 오류 (계층 검사, leafCount 문구)', async () => {
  const opts = await combineOpts();
  assert.throws(() => cullAndSelect(zeroLeafHierarchy(), good(), opts), (e) => CULL.test(String(e)) && /^Error: cull: 계층이 올바르지 않음 \(lod: 계층의 팔진 트리가 올바르지 않음\)/.test(String(e)));
});

test('리프 0 개 계층(leafCount 0): backface 기본 구현(loadDefaultImpls)도 cull: 오류', async () => {
  const d = await loadDefaultImpls();
  assert.throws(() => d.stageImpls.backface(zeroLeafHierarchy(), good(), { pointSizeM: 0.1 }), CULL);
});

// ---- 양성 대조: leafCount ≥ 1 인 같은 구성의 정상 계층은 던지지 않는다 -----------------------
const POS = [
  ['frustumCull', (h) => frustumCull(h, good())],
  ['distanceCull', (h) => distanceCull(h, good(), { maxDistanceM: 100 })],
  ['leafNormalCones', (h) => leafNormalCones(h)],
  ['backfaceCull', (h) => backfaceCull(h, good(), leafNormalCones(h))],
  ['buildDepthPyramid', (h) => buildDepthPyramid(h, good())],
  ['occlusionCull', (h) => occlusionCull(h, good(), buildDepthPyramid(h, good()))],
  ['leafPriority', (h) => leafPriority(h, good())],
  ['orderChunks', (h) => orderChunks(h, good(), new Uint8Array(h.octree.leafCount).fill(1))],
  ['predictiveMask', (h) => predictiveMask(h, state(), PRED)],
  ['leafBoxesOf', (h) => leafBoxesOf(h.octree)],
];
for (const [name, run] of POS) {
  test(`양성 대조(leafCount ≥ 1): ${name} 은 던지지 않음`, () => {
    const h = healthy();
    assert.ok(h.octree.leafCount >= 1);
    assert.doesNotThrow(() => run(h));
  });
}

test('양성 대조(leafCount ≥ 1): cullAndSelect 는 던지지 않음', async () => {
  const opts = await combineOpts();
  assert.doesNotThrow(() => cullAndSelect(healthy(), good(), opts));
});
