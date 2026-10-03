// F-156 ⑦: NaN 리프 상자 정책표를 단계별로 단언한다(contracts/cull/index.mjs 의 'NaN 리프 정책표' 문단).
// 정책: 상자 좌표에 NaN 이 있는 리프는 '무엇을 해야 할지 모르는 것'이므로 거짓 제거 0 원칙에 따라 단독 호출 어디서도 제거하지 않는다.
//   마스크 단계 = 1(남김), priority = 유한한 점수(정렬 키가 깨지지 않게), orderChunks = 목록에 남김.
//   NaN 을 아예 받지 않는 단계(backface·leafNormalCones·cullAndSelect)는 조용히 지우지 않고 'cull:' 오류로 거부한다.
//   ±Infinity 리프는 모든 서버 단계에서 'cull:' 오류다(F-149/F-157; 상세는 nonfinite_box_scope.test.mjs).
// 이 시험은 NaN 패턴(전 좌표·min 만·max 만)을 단계 × 패턴 표로 돌린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { frustumCull } from '../frustum/index.mjs';
import { distanceCull } from '../distance/index.mjs';
import { leafNormalCones, backfaceCull } from '../backface/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../occlusion/index.mjs';
import { leafPriority, orderChunks } from '../priority/index.mjs';
import { predictiveMask } from '../predict/index.mjs';
import { cullAndSelect, loadDefaultImpls } from '../combine/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { leafBoxesOf, clientFrustumCull } from '../../../client/cull/index.mjs';

const isCullError = (e) => e instanceof Error && !(e instanceof TypeError) && /^cull:/.test(e.message);
const cam = () => ({ width: 64, height: 48, K: { fx: 100, fy: 100, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const { cloud } = generate({ seed: 1, count: 2000 });
const base = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 64 });
const pyr = buildDepthPyramid(base, cam());
const cones = leafNormalCones(base);
const allOn = new Uint8Array(base.octree.leafCount).fill(1);
const impls = await loadDefaultImpls();

// 정상일 때 마스크가 1 인 리프를 깨뜨려야 '정당하게 제거된 것'과 구분된다. distance 는 가까운 리프만 남기므로 반경을 넉넉히 둔다.
const STAGES = [
  { name: 'frustumCull(pointSizeM 없음)', kind: 'mask', run: (h) => frustumCull(h, cam(), {}) },
  { name: 'frustumCull(pointSizeM)', kind: 'mask', run: (h) => frustumCull(h, cam(), { pointSizeM: 0.1 }) },
  { name: 'distanceCull', kind: 'mask', run: (h) => distanceCull(h, cam(), { maxDistanceM: 1e4 }) },
  { name: 'occlusionCull', kind: 'mask', run: (h) => occlusionCull(h, cam(), pyr) },
  { name: 'predictiveMask', kind: 'mask', run: (h) => predictiveMask(h, { camera: cam() }, { horizonS: 1, steps: 2, pointSizeM: 0.1 }) },
  { name: 'clientFrustumCull(pointSizeM 없음)', kind: 'mask', run: (h) => clientFrustumCull(leafBoxesOf(h.octree), cam(), {}) },
  { name: 'clientFrustumCull(pointSizeM)', kind: 'mask', run: (h) => clientFrustumCull(leafBoxesOf(h.octree), cam(), { pointSizeM: 0.1 }) },
  { name: 'leafPriority', kind: 'score', run: (h) => leafPriority(h, cam()) },
  { name: 'orderChunks', kind: 'chunks', run: (h) => orderChunks(h, cam(), allOn) },
  { name: 'backfaceCull', kind: 'throw', run: (h) => backfaceCull(h, cam(), cones) },
  { name: 'leafNormalCones', kind: 'throw', run: (h) => leafNormalCones(h) },
  { name: 'cullAndSelect', kind: 'throw', run: (h) => cullAndSelect(h, cam(), { thresholdPx: 1, stageImpls: impls.stageImpls, orderChunks: impls.orderChunks, isDegenerateView: impls.isDegenerateView }) },
];

const PATTERNS = [
  ['min 전 좌표', (a, b, n) => { for (let c = 0; c < 3; c++) a[3 * n + c] = NaN; }],
  ['max 전 좌표', (a, b, n) => { for (let c = 0; c < 3; c++) b[3 * n + c] = NaN; }],
  ['min.x', (a, b, n) => { a[3 * n] = NaN; }],
  ['min.y', (a, b, n) => { a[3 * n + 1] = NaN; }],
  ['max.z', (a, b, n) => { b[3 * n + 2] = NaN; }],
  ['min·max 모두 전 좌표', (a, b, n) => { for (let c = 0; c < 3; c++) { a[3 * n + c] = NaN; b[3 * n + c] = NaN; } }],
];

function broken(leafNode, patch) {
  const oc = { ...base.octree, boxMin: new Float32Array(base.octree.boxMin), boxMax: new Float32Array(base.octree.boxMax) };
  patch(oc.boxMin, oc.boxMax, leafNode);
  return { ...base, octree: oc };
}
const nodeOf = (k) => { for (let i = 0; i < base.octree.nodeCount; i++) if (base.octree.leafIndex[i] === k) return i; return -1; };

for (const st of STAGES) {
  for (const [label, patch] of PATTERNS) {
    test(`${st.name} × NaN 리프(${label}): ${st.kind === 'throw' ? "throw 'cull:'" : '제거하지 않음'}`, async () => {
      if (st.kind === 'throw') {
        assert.throws(() => st.run(broken(nodeOf(0), patch)), isCullError);
        return;
      }
      const ref = await st.run(base);
      // 시험 대상 리프: 정상 결과에서 남던 리프(마스크), 아니면 아무 리프. 어느 리프를 깨뜨려도 정책은 같아야 한다.
      const ks = [];
      for (let k = 0; k < base.octree.leafCount && ks.length < 8; k++) if (st.kind !== 'mask' || ref[k] === 1) ks.push(k);
      assert.ok(ks.length > 0, `${st.name}: 정상 마스크에 남는 리프가 없음`);
      for (const k of ks) {
        const got = await st.run(broken(nodeOf(k), patch));
        if (st.kind === 'mask') assert.equal(got[k], 1, `리프 ${k} 가 제거됨`);
        else if (st.kind === 'score') assert.ok(Number.isFinite(got[k]), `리프 ${k} 점수가 유한하지 않음`);
        else assert.ok(got.includes(k), `리프 ${k} 가 조각 목록에서 빠짐`);
      }
    });
  }
}

// F-162 ②: distanceCull 은 NaN 축의 간격을 0 으로 두고 '유한한 축만으로' 판정한다(boxDistanceM 의 비교가 NaN 에서 거짓 → 간격 0).
//   hypot 이 넘쳐 Infinity 면 제거, 유한 축만으로는 거리가 0 이거나 유한이라 남김(boxDistanceM 이 NaN 간격을 0 으로 취급).
//   간격 하한만 쓰므로 유한 축만으로 확실히 먼 리프를 제거하는 것은 거짓 제거가 아니다. 위 표는 maxDistanceM 1e4 라 이 경우를 피한다.
//   카메라 중심은 원점(R=I, t=0)이다. 비어있지 않은 리프 하나(k)의 상자를 직접 덮어쓴다.
function distanceWith(boxFn) {
  let k = 0;
  while (base.levels[0].leafStart[k] >= base.levels[0].leafStart[k + 1]) k++;
  const node = nodeOf(k);
  const oc = { ...base.octree, boxMin: new Float32Array(base.octree.boxMin), boxMax: new Float32Array(base.octree.boxMax) };
  boxFn(oc.boxMin, oc.boxMax, node);
  return { k, h: { ...base, octree: oc } };
}

test('distanceCull × NaN 축(min.x) + 유한 축(y)만으로 확실히 먼 리프: 제거(0)', () => {
  const { k, h } = distanceWith((a, b, n) => {
    a[3 * n] = NaN; b[3 * n] = 1;
    a[3 * n + 1] = 1e6; b[3 * n + 1] = 1e6 + 1;
    a[3 * n + 2] = -1; b[3 * n + 2] = 1;
  });
  assert.equal(distanceCull(h, cam(), { maxDistanceM: 100 })[k], 0);
});

test('distanceCull × NaN 축(min.x) + 유한 축으로는 가까운 리프(반경 큼): 남김(1)', () => {
  const { k, h } = distanceWith((a, b, n) => {
    a[3 * n] = NaN; b[3 * n] = 1;
    a[3 * n + 1] = 10; b[3 * n + 1] = 11;
    a[3 * n + 2] = -1; b[3 * n + 2] = 1;
  });
  assert.equal(distanceCull(h, cam(), { maxDistanceM: 100 })[k], 1);
});

test('distanceCull × min.x=NaN·max.x=-1e6(NaN 쪽 비교 무시, 유한 경계로 간격): 간격 1e6', () => {
  const { k, h } = distanceWith((a, b, n) => {
    a[3 * n] = NaN; b[3 * n] = -1e6;
    a[3 * n + 1] = -1; b[3 * n + 1] = 1;
    a[3 * n + 2] = -1; b[3 * n + 2] = 1;
  });
  assert.equal(distanceCull(h, cam(), { maxDistanceM: 1e6 + 1 })[k], 1);
  assert.equal(distanceCull(h, cam(), { maxDistanceM: 1e6 - 1 })[k], 0);
});

// F-166 ①: 비퇴화 카메라가 극단 좌표에 있을 때의 거리 제거. 카메라 중심 C = -Rᵀt 이고 장면 상자는 원점 근방(수 m)이라
//   축별 간격이 약 |t| 이고 실제 거리는 약 √3·|t| 다. 72 리프 전부가 비어있지 않으므로 기준을 넘으면 모두 0 이어야 한다.
//   두 행 모두 '실제 거리가 기준을 진짜로 넘는' 제거라 거짓 제거가 아니다. 대조: 카메라가 원점이면 같은 반경에서 72 개 모두 1.
//   · t=1e308×3: 거리 ≈ 1.732e308 은 double 범위(≈1.797e308) 안이라 hypot 이 유한값을 돌려준다(오버플로 없음). 1.7e308 초과 → 0.
//   · t=1.2e308×3: 실제 거리 ≈ 2.078e308 이 double 범위를 넘어 hypot 이 Infinity 를 돌려준다. 실제 거리도 기준 초과 → 0(Infinity > 기준).
//     이 행은 거리 비교를 isFinite 가드로 바꾸면(Infinity 를 '남김' 으로 처리) 실패한다.
const nearSum = () => distanceCull(base, cam(), { maxDistanceM: 1.7e308 }).reduce((s, v) => s + v, 0);
test('distanceCull × 극단 카메라 t=[1e308×3], maxDistanceM=1.7e308: 72 리프 모두 제거(0) — 유한 거리 약 1.732e308 이 기준 초과', () => {
  const far = { ...cam(), t: [1e308, 1e308, 1e308] };
  assert.equal(base.octree.leafCount, 72);
  const m = distanceCull(base, far, { maxDistanceM: 1.7e308 });
  assert.equal(m.length, 72);
  assert.equal(m.reduce((s, v) => s + v, 0), 0);
  assert.equal(nearSum(), 72);
});

test('distanceCull × 극단 카메라 t=[1.2e308×3], maxDistanceM=1.7e308: hypot 오버플로 Infinity 거리, 72 리프 모두 제거(0) — 실제 거리 약 2.078e308 도 기준 초과', () => {
  const far = { ...cam(), t: [1.2e308, 1.2e308, 1.2e308] };
  const m = distanceCull(base, far, { maxDistanceM: 1.7e308 });
  assert.equal(m.length, 72);
  assert.equal(m.reduce((s, v) => s + v, 0), 0);
  assert.equal(nearSum(), 72);
});
