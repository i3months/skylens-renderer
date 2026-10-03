// F-155 ③: 각 컬링 단계가 ±Inf·NaN 상자 좌표를 어디까지 거부하는지 계약 문구(contracts/cull/index.mjs 머리 주석)로 시험한다.
// 표 = 단계 × 입력 종류(±Inf 내부 노드·NaN 리프·NaN 내부 노드·±Inf 리프).
// 계약 문구를 시험한다: 관찰 결과를 받아 적지 않고, 정책(남김 = 1, 거짓 제거 0)을 단언한다.
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
import { leafBoxesOf, clientFrustumCull } from '../../../client/cull/index.mjs';

// 'cull:' 오류 검사: 메시지가 'cull:' 로 시작하고 TypeError 가 아니어야 한다(assert.throws 의 정규식은 이름 'Error: ' 까지 검사하므로 메시지에 직접 건다).
const isCullError = (e) => e instanceof Error && !(e instanceof TypeError) && /^cull:/.test(e.message);

const good = () => ({ width: 64, height: 48, K: { fx: 100, fy: 100, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const { cloud } = generate({ seed: 1, count: 2000 });
const healthy = () => buildHierarchy(cloud, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 64 });

function getFirstLeafNode(hierarchy) {
  const oc = hierarchy.octree;
  for (let i = 0; i < oc.nodeCount; i++) {
    if (oc.leafIndex[i] >= 0) return i;
  }
  return -1;
}

function getFirstInternalNode(hierarchy) {
  const oc = hierarchy.octree;
  for (let i = 0; i < oc.nodeCount; i++) {
    if (oc.leafIndex[i] < 0) return i;
  }
  return -1;
}

function withModifiedBox(hierarchy, nodeIndex, coordIndex, value) {
  const h = {
    ...hierarchy,
    octree: { ...hierarchy.octree },
    levels: hierarchy.levels,
  };
  h.octree.boxMin = new Float32Array(hierarchy.octree.boxMin);
  h.octree.boxMax = new Float32Array(hierarchy.octree.boxMax);

  if (Number.isNaN(value)) {
    h.octree.boxMin[3 * nodeIndex + coordIndex] = NaN;
  } else if (value === Infinity) {
    h.octree.boxMin[3 * nodeIndex + coordIndex] = Infinity;
  } else if (value === -Infinity) {
    h.octree.boxMax[3 * nodeIndex + coordIndex] = -Infinity;
  }
  return h;
}

const state = () => ({ camera: good(), velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] });
const PRED = { horizonS: 1, steps: 2, pointSizeM: 0.1 };

const baseH = healthy();
const okCones = leafNormalCones(baseH);
const okPyr = buildDepthPyramid(baseH, good());
const okMask = new Uint8Array(baseH.octree.leafCount).fill(1);

const sameArray = (a, b, msg) => assert.deepStrictEqual(Array.from(a), Array.from(b), msg);

// 리프 k 의 노드 번호
function nodeOfLeaf(h, k) {
  const oc = h.octree;
  for (let i = 0; i < oc.nodeCount; i++) if (oc.leafIndex[i] === k) return i;
  return -1;
}

// 단계 11개. run(h) 은 단계 결과를 돌려주거나 던진다(cullAndSelect 는 비동기).
// kind: 결과 형식별 단언 방식. mask = 마스크(1 남김), score = 점수, chunks = 조각 목록, boxes = 리프 상자(클라이언트 입력), none = 항상 던짐.
// serverLeafInf: 리프 ±Infinity 를 거부하는가(계약: 서버 단계 전부 'cull:' 오류). 클라이언트 leafBoxesOf 는 상자를 그대로 넘기므로(계약: 클라이언트 통과) 거부는 clientFrustumCull 이 한다.
const impls = await loadDefaultImpls();
const STAGES = [
  { name: 'frustumCull', kind: 'mask', run: (h) => frustumCull(h, good(), { pointSizeM: 0.1 }) },
  { name: 'distanceCull', kind: 'mask', run: (h) => distanceCull(h, good(), { maxDistanceM: 3 }) },
  { name: 'leafNormalCones', kind: 'none', throwsNaN: true, run: (h) => leafNormalCones(h) },
  { name: 'backfaceCull', kind: 'none', throwsNaN: true, run: (h) => backfaceCull(h, good(), okCones) },
  { name: 'occlusionCull', kind: 'mask', run: (h) => occlusionCull(h, good(), okPyr) },
  { name: 'leafPriority', kind: 'score', run: (h) => leafPriority(h, good()) },
  { name: 'predictiveMask', kind: 'mask', run: (h) => predictiveMask(h, state(), PRED) },
  { name: 'orderChunks', kind: 'chunks', run: (h) => orderChunks(h, good(), okMask) },
  { name: 'leafBoxesOf', kind: 'boxes', leafInfPasses: true, run: (h) => leafBoxesOf(h.octree) },
  { name: 'clientFrustumCull', kind: 'mask', run: (h) => clientFrustumCull(leafBoxesOf(h.octree), good(), { pointSizeM: 0.1 }) },
  {
    name: 'cullAndSelect', kind: 'none', throwsNaN: true,
    run: (h) => cullAndSelect(h, good(), {
      thresholdPx: 1,
      stageImpls: impls.stageImpls,
      orderChunks: impls.orderChunks,
      isDegenerateView: impls.isDegenerateView,
    }),
  },
];

// 시험 대상 리프: 비어 있지 않은 리프 중 정상 마스크 값이 1 인 것(마스크 단계), 아니면 첫 비어 있지 않은 리프.
// (정상값 0 인 리프는 NaN 이 아닌 다른 축으로 정당하게 제거될 수 있어 '남김' 단언 대상이 아니다.)
function leavesToBreak(stage) {
  const ls = baseH.levels[0].leafStart;
  const nonEmpty = [];
  for (let k = 0; k < baseH.octree.leafCount; k++) if (ls[k + 1] > ls[k]) nonEmpty.push(k);
  assert.ok(nonEmpty.length > 0);
  if (stage.kind !== 'mask') return [nonEmpty[0]];
  const base = stage.run(baseH);
  const one = nonEmpty.find((k) => base[k] === 1);
  assert.notEqual(one, undefined, `${stage.name}: 정상 마스크에 남는 리프가 없음`);
  return [one];
}

// 단계 목록이 실제로 정상 마스크에서 1 과 0 을 모두 만드는지(시험이 변별력을 갖는지) 확인한다. 문턱은 올리기만 한다.
test('변별력: 마스크 단계의 정상 마스크에 1 과 0 이 모두 있다(distance·frustum·client)', () => {
  for (const name of ['frustumCull', 'distanceCull', 'clientFrustumCull']) {
    const st = STAGES.find((s) => s.name === name);
    const base = st.run(baseH);
    assert.ok(base.includes(1) && base.includes(0), `${name}: 정상 마스크가 한쪽 값뿐이면 거짓 제거를 변별하지 못함`);
  }
});

const COORDS = [0, 1, 2];
const AXIS = ['x', 'y', 'z'];

// 내부 노드 ±Inf·NaN: 통과 단계는 결과가 정상과 완전히 같아야 한다(내부 노드 상자는 쓰지 않음). 거부 단계는 'cull:' 오류.
for (const st of STAGES) {
  for (const [label, value] of [['Inf', Infinity], ['-Inf', -Infinity], ['NaN', NaN]]) {
    const passesInternal = st.kind !== 'none';
    test(`${st.name} × ${label} 내부 노드: ${passesInternal ? 'pass (결과 불변)' : 'throw cull:'}`, async () => {
      const node = getFirstInternalNode(baseH);
      assert.ok(node >= 0);
      // 계약: 모든 노드 NaN·±Inf 를 거부하는 단계(assertHierarchyInput)는 내부 노드도 던진다. 그 밖의 단계는 리프만 ±Inf 를 거부한다.
      const h = withModifiedBox(baseH, node, 0, value);
      if (!passesInternal) {
        assert.throws(() => st.run(h), isCullError);
        return;
      }
      const base = await st.run(baseH);
      const got = await st.run(h);
      if (st.kind === 'boxes') {
        sameArray(got.boxMin, base.boxMin);
        sameArray(got.boxMax, base.boxMax);
      } else {
        sameArray(got, base);
      }
    });
  }
}

// NaN 리프: 계약 정책 = 남김(1, 거짓 제거 0). 다른 리프는 정상 결과와 같아야 한다. NaN 을 받는 서버 단계(NaN 거부)는 'cull:' 오류.
for (const st of STAGES) {
  for (const axis of COORDS) {
    test(`${st.name} × NaN 리프(${AXIS[axis]}): ${st.throwsNaN ? 'throw cull:' : 'pass (남김 = 1)'}`, async () => {
      if (st.throwsNaN) {
        const node = getFirstLeafNode(baseH);
        assert.ok(node >= 0);
        assert.throws(() => st.run(withModifiedBox(baseH, node, axis, NaN)), isCullError);
        return;
      }
      const base = await st.run(baseH);
      for (const k of leavesToBreak(st)) {
        const node = nodeOfLeaf(baseH, k);
        assert.ok(node >= 0);
        const got = await st.run(withModifiedBox(baseH, node, axis, NaN));
        const where = `${st.name} 리프 ${k}`;
        if (st.kind === 'mask') {
          assert.ok(got instanceof Uint8Array);
          assert.equal(got.length, base.length);
          assert.equal(got[k], 1, `${where}: NaN 리프는 남겨야 함(거짓 제거 0), 정상값 ${base[k]}`);
          for (let j = 0; j < base.length; j++) if (j !== k) assert.equal(got[j], base[j], `${where}: 다른 리프 ${j} 가 변함`);
        } else if (st.kind === 'score') {
          assert.ok(got instanceof Float64Array);
          assert.equal(got.length, base.length);
          // 점수는 정렬 키이므로 NaN 이 새면 순서가 깨진다: 유한해야 하며 다른 리프는 변하지 않는다
          assert.ok(Number.isFinite(got[k]), `${where}: 점수가 유한하지 않음`);
          for (let j = 0; j < base.length; j++) if (j !== k) assert.equal(got[j], base[j], `${where}: 다른 리프 ${j} 가 변함`);
        } else if (st.kind === 'chunks') {
          assert.ok(got instanceof Uint32Array);
          // 마스크가 모두 1 이므로 NaN 리프도 조각 목록에 남아야 하고, 목록의 리프 집합은 정상과 같다
          assert.ok(got.includes(k), `${where}: 조각 목록에서 빠짐`);
          sameArray(Array.from(got).sort((a, b) => a - b), Array.from(base).sort((a, b) => a - b));
        } else if (st.kind === 'boxes') {
          assert.ok(got.boxMin instanceof Float32Array);
          // 클라이언트 상자는 입력 그대로: 망가뜨린 좌표만 NaN, 나머지는 정상과 같다
          assert.ok(Number.isNaN(got.boxMin[3 * k + axis]));
          const gm = Array.from(got.boxMin), bm = Array.from(base.boxMin);
          gm[3 * k + axis] = bm[3 * k + axis];
          sameArray(gm, bm);
          sameArray(got.boxMax, base.boxMax);
        }
      }
    });
  }
}

// 리프 ±Inf: 계약 = 구조 오류('cull:' 오류). boxMin +Inf 와 boxMax −Inf(withModifiedBox 의 boxMax 분기)를 x·y·z 모두 시험한다.
// 클라이언트 leafBoxesOf 는 상자를 그대로 통과시키므로(계약) 그 결과를 clientFrustumCull 이 거부하는지로 시험한다.
for (const st of STAGES) {
  for (const [label, value] of [['+Inf(boxMin)', Infinity], ['-Inf(boxMax)', -Infinity]]) {
    for (const axis of COORDS) {
      test(`${st.name} × ${label} 리프(${AXIS[axis]}): throw cull:`, async () => {
        const node = getFirstLeafNode(baseH);
        assert.ok(node >= 0);
        const h = withModifiedBox(baseH, node, axis, value);
        // withModifiedBox 가 의도한 분기(boxMin / boxMax)를 실제로 건드렸는지 확인
        if (value === Infinity) assert.equal(h.octree.boxMin[3 * node + axis], Infinity);
        else assert.equal(h.octree.boxMax[3 * node + axis], -Infinity);
        if (st.leafInfPasses) {
          const boxes = await st.run(h);
          assert.ok(boxes.boxMin instanceof Float32Array);
          assert.throws(() => clientFrustumCull(boxes, good()), isCullError);
          return;
        }
        assert.throws(() => st.run(h), isCullError);
      });
    }
  }
}
