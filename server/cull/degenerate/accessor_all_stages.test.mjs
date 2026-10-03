// F-148 ③: 접근자(getter)·Proxy 가 던지는 계층 입력에 대해 모든 컬링 단계가 원래 TypeError 를 흘리지 않고 'cull:' 오류를 던진다.
// 표 = 단계 이름 × 입력 종류. 양성 대조로 같은 호출이 정상 계층에서는 던지지 않음도 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { frustumCull } from '../frustum/index.mjs';
import { distanceCull } from '../distance/index.mjs';
import { leafNormalCones, backfaceCull } from '../backface/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../occlusion/index.mjs';
import { leafPriority, orderChunks } from '../priority/index.mjs';
import { cullAndSelect, cachedNormalCones, loadDefaultImpls } from '../combine/index.mjs';
import { predictiveMask } from '../predict/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { leafBoxesOf } from '../../../client/cull/index.mjs';

const CULL = /^Error: cull:/;
const isCullError = (e) => CULL.test(String(e)) && !(e instanceof TypeError);
const good = () => ({ width: 64, height: 48, K: { fx: 100, fy: 100, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const { cloud } = generate({ seed: 1, count: 2000 });
const healthy = () => buildHierarchy(cloud, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 64 });
const boom = () => { throw new TypeError('accessor boom'); };
const throwingProxy = (target) => new Proxy(target, { get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom });

// 복사본의 key 를 읽으면 던지는 접근자로 바꾼다.
const withGetter = (obj, key) => {
  const copy = { ...obj };
  Object.defineProperty(copy, key, { get: boom, enumerable: true, configurable: true });
  return copy;
};

// 입력 종류: 정상 계층을 받아 읽을 때 던지는 계층을 만든다.
const HIER_INPUTS = [
  ['octree.leafCount getter', (h) => ({ ...h, octree: withGetter(h.octree, 'leafCount') })],
  ['octree.boxMin getter', (h) => ({ ...h, octree: withGetter(h.octree, 'boxMin') })],
  ['octree getter', (h) => withGetter(h, 'octree')],
  ['levels getter', (h) => withGetter(h, 'levels')],
  ['levels[0].leafStart getter', (h) => ({ ...h, levels: [withGetter(h.levels[0], 'leafStart'), ...h.levels.slice(1)] })],
  ['Proxy octree', (h) => ({ ...h, octree: throwingProxy(h.octree) })],
  ['Proxy 계층', (h) => throwingProxy(h)],
];
const OCTREE_INPUTS = [
  ['leafCount getter', (o) => withGetter(o, 'leafCount')],
  ['leafIndex getter', (o) => withGetter(o, 'leafIndex')],
  ['boxMax getter', (o) => withGetter(o, 'boxMax')],
  ['Proxy octree', (o) => throwingProxy(o)],
];

const state = () => ({ camera: good(), velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] });
const PRED = { horizonS: 1, steps: 2, pointSizeM: 0.1 };
const impls = await loadDefaultImpls();
const combineOpts = { thresholdPx: 1, stageImpls: impls.stageImpls, orderChunks: impls.orderChunks, isDegenerateView: impls.isDegenerateView };
// 입력 계층만 망가뜨리고 나머지 인자(원뿔·피라미드·마스크)는 정상으로 둔다.
const okCones = leafNormalCones(healthy());
const okPyr = buildDepthPyramid(healthy(), good());
const okMask = (h) => new Uint8Array(healthy().octree.leafCount).fill(1);

const STAGES = [
  ['frustumCull', (h) => frustumCull(h, good())],
  ['distanceCull', (h) => distanceCull(h, good(), { maxDistanceM: 100 })],
  ['backfaceCull', (h) => backfaceCull(h, good(), okCones)],
  ['leafNormalCones', (h) => leafNormalCones(h)],
  ['occlusionCull', (h) => occlusionCull(h, good(), okPyr)],
  ['leafPriority', (h) => leafPriority(h, good())],
  ['orderChunks', (h) => orderChunks(h, good(), okMask(h))],
  ['predictiveMask', (h) => predictiveMask(h, state(), PRED)],
  ['cullAndSelect', (h) => cullAndSelect(h, good(), combineOpts)],
  ['cachedNormalCones', (h) => cachedNormalCones(h, leafNormalCones)],
];

for (const [stage, run] of STAGES) {
  for (const [input, make] of HIER_INPUTS) {
    test(`${stage} × ${input}: cull: 오류`, () => {
      const bad = make(healthy());
      assert.throws(() => run(bad), isCullError, `${stage} 가 'cull:' 오류가 아닌 오류를 흘림`);
    });
  }
}

for (const [input, make] of OCTREE_INPUTS) {
  test(`leafBoxesOf × ${input}: cull: 오류`, () => {
    assert.throws(() => leafBoxesOf(make(healthy().octree)), isCullError);
  });
}

// ---- 양성 대조: 접근자 없는 정상 계층은 같은 호출이 던지지 않는다 ----------------------------------
for (const [stage, run] of STAGES) {
  test(`양성 대조: ${stage} 는 정상 계층에서 던지지 않음`, () => {
    assert.doesNotThrow(() => run(healthy()));
  });
}
test('양성 대조: leafBoxesOf 는 정상 octree 에서 던지지 않음', () => {
  assert.doesNotThrow(() => leafBoxesOf(healthy().octree));
});
