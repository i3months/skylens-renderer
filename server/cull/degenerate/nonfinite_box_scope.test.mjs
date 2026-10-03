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
import { readFileSync } from 'node:fs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
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

// nodeIndex·coordIndex 는 숫자 하나 또는 배열(배열이면 모든 조합을 한 번에 바꾼다). which 를 주면 그 배열(boxMin·boxMax)에 value 를 쓴다.
// which 가 없으면 NaN·+Inf 는 boxMin, -Inf 는 boxMax 에 쓴다.
function withModifiedBox(hierarchy, nodeIndex, coordIndex, value, which) {
  const h = {
    ...hierarchy,
    octree: { ...hierarchy.octree },
    levels: hierarchy.levels,
  };
  h.octree.boxMin = new Float32Array(hierarchy.octree.boxMin);
  h.octree.boxMax = new Float32Array(hierarchy.octree.boxMax);

  const target = which ?? (value === -Infinity ? 'boxMax' : 'boxMin');
  const nodes = Array.isArray(nodeIndex) ? nodeIndex : [nodeIndex];
  const coords = Array.isArray(coordIndex) ? coordIndex : [coordIndex];
  for (const n of nodes) for (const c of coords) h.octree[target][3 * n + c] = value;
  return h;
}

const state = () => ({ camera: good(), velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] });
// nan_y_leaf.test.mjs 와 같은 높은 시점(eye [0,120,140]): good() 카메라에서는 boxMin.z 의 NaN 판정이 드러나지 않아 이 카메라 행을 따로 둔다.
const highCam = () => viewpointToCamera({ eye: [0, 120, 140], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 });
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
  { name: 'predictiveMask(eye 0,120,140)', kind: 'mask', run: (h) => predictiveMask(h, { camera: highCam(), velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] }, PRED) },
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

// 시험 대상 리프: 비어 있지 않은 리프 중 정상 마스크 값이 1 인 것 전부(마스크 단계), 그 밖의 단계는 비어 있지 않은 리프 전부.
// (정상값 0 인 리프는 NaN 이 아닌 다른 축으로 정당하게 제거될 수 있어 '남김' 단언 대상이 아니다.)
function leavesToBreak(stage) {
  const ls = baseH.levels[0].leafStart;
  const nonEmpty = [];
  for (let k = 0; k < baseH.octree.leafCount; k++) if (ls[k + 1] > ls[k]) nonEmpty.push(k);
  assert.ok(nonEmpty.length > 0);
  if (stage.kind !== 'mask') return nonEmpty;
  const base = stage.run(baseH);
  const ones = nonEmpty.filter((k) => base[k] === 1);
  assert.ok(ones.length > 0, `${stage.name}: 정상 마스크에 남는 리프가 없음`);
  return ones;
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
// 정상 마스크에서 1 인 모든 리프 × boxMin·boxMax × x·y·z 를 각각 시험한다(축·배열마다 대상 리프 전부를 한 번에 NaN 으로 바꾼다).
// occlusionCull 은 팔진 트리 상자를 쓰지 않고 levels[0].positions 로 판정하므로 이 행은 상자 NaN 이 새지 않음만 보고, 점 좌표 행은 아래 별도 표가 맡는다.
for (const st of STAGES) {
  for (const which of ['boxMin', 'boxMax']) {
    for (const axis of COORDS) {
      test(`${st.name} × NaN 리프(${which}.${AXIS[axis]}): ${st.throwsNaN ? 'throw cull:' : 'pass (남김 = 1)'}`, async () => {
        if (st.throwsNaN) {
          const node = getFirstLeafNode(baseH);
          assert.ok(node >= 0);
          assert.throws(() => st.run(withModifiedBox(baseH, node, axis, NaN, which)), isCullError);
          return;
        }
        const base = await st.run(baseH);
        const ks = leavesToBreak(st);
        const nodes = ks.map((k) => nodeOfLeaf(baseH, k));
        assert.ok(nodes.every((n) => n >= 0));
        const h = withModifiedBox(baseH, nodes, axis, NaN, which);
        for (const n of nodes) assert.ok(Number.isNaN(h.octree[which][3 * n + axis]));
        const got = await st.run(h);
        const broken = new Set(ks);
        const where = `${st.name} ${which}.${AXIS[axis]}`;
        if (st.kind === 'mask') {
          assert.ok(got instanceof Uint8Array);
          assert.equal(got.length, base.length);
          for (const k of ks) assert.equal(got[k], 1, `${where} 리프 ${k}: NaN 리프는 남겨야 함(거짓 제거 0), 정상값 ${base[k]}`);
          for (let j = 0; j < base.length; j++) if (!broken.has(j)) assert.equal(got[j], base[j], `${where}: 다른 리프 ${j} 가 변함`);
        } else if (st.kind === 'score') {
          assert.ok(got instanceof Float64Array);
          assert.equal(got.length, base.length);
          // 점수는 정렬 키이므로 NaN 이 새면 순서가 깨진다: 유한해야 하며 다른 리프는 변하지 않는다
          for (const k of ks) assert.ok(Number.isFinite(got[k]), `${where} 리프 ${k}: 점수가 유한하지 않음`);
          for (let j = 0; j < base.length; j++) if (!broken.has(j)) assert.equal(got[j], base[j], `${where}: 다른 리프 ${j} 가 변함`);
        } else if (st.kind === 'chunks') {
          assert.ok(got instanceof Uint32Array);
          // 마스크가 모두 1 이므로 NaN 리프도 조각 목록에 남아야 하고, 목록의 리프 집합은 정상과 같다
          for (const k of ks) assert.ok(got.includes(k), `${where} 리프 ${k}: 조각 목록에서 빠짐`);
          sameArray(Array.from(got).sort((a, b) => a - b), Array.from(base).sort((a, b) => a - b));
        } else if (st.kind === 'boxes') {
          assert.ok(got.boxMin instanceof Float32Array);
          // 클라이언트 상자는 입력 그대로: 망가뜨린 좌표만 NaN, 나머지는 정상과 같다
          for (const k of ks) assert.ok(Number.isNaN(got[which][3 * k + axis]), `${where} 리프 ${k}: 상자가 그대로 아님`);
          const g = Array.from(got[which]), b = Array.from(base[which]);
          for (const k of ks) g[3 * k + axis] = b[3 * k + axis];
          sameArray(g, b);
          sameArray(got[which === 'boxMin' ? 'boxMax' : 'boxMin'], base[which === 'boxMin' ? 'boxMax' : 'boxMin']);
        }
      });
    }
  }
}

// occlusionCull 은 levels[0].positions(tightLeafBoxes)로 판정한다: 정상 마스크가 1 인 모든 리프에서 점 하나의 좌표 하나를 NaN·±Inf 로 바꿔도 그 리프는 남는다(판정 포기 = 남김).
// 다른 리프는 정상 결과와 같아야 한다. 축마다 대상 리프 전부를 한 번에 바꾼다.
function withModifiedPoints(hierarchy, leaves, coord, value) {
  const lv0 = hierarchy.levels[0];
  const positions = new Float32Array(lv0.positions);
  for (const k of leaves) positions[3 * lv0.leafStart[k] + coord] = value;
  return { ...hierarchy, levels: [{ ...lv0, positions }, ...hierarchy.levels.slice(1)] };
}

// 정상 마스크에 0(가림 제거)과 1 이 모두 있는 장면: flat_boxes 200000 점, 고정 시점 5(occlusion.test.mjs 와 같은 해상도·size·pointSizeM).
const occVp = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints.find((v) => v.id === 5);
const occCam = viewpointToCamera({ ...occVp, width: 320, height: 180 });
let occScene = null;
function occlusionScene() {
  if (!occScene) {
    const h = buildHierarchy(generate({ seed: 1, count: 200000 }).cloud, { edge0M: 0.5, levelCount: 1, maxLeafPoints: 256 });
    const pyr = buildDepthPyramid(h, occCam, { size: 64, pointSizeM: 0.75 });
    occScene = { h, pyr, base: occlusionCull(h, occCam, pyr) };
  }
  return occScene;
}

for (const [label, value] of [['NaN', NaN], ['Inf', Infinity], ['-Inf', -Infinity]]) {
  for (const axis of COORDS) {
    test(`occlusionCull × ${label} 점 좌표(levels[0].positions ${AXIS[axis]}): 그 리프는 남김 = 1`, () => {
      const { h: oh, pyr, base } = occlusionScene();
      assert.ok(base.includes(0) && base.includes(1), '정상 마스크가 한쪽 값뿐이면 거짓 제거를 변별하지 못함');
      const ls = oh.levels[0].leafStart;
      const ks = [];
      for (let k = 0; k < base.length; k++) if (base[k] === 1 && ls[k + 1] > ls[k]) ks.push(k);
      const h = withModifiedPoints(oh, ks, axis, value);
      for (const k of ks) assert.equal(h.levels[0].positions[3 * ls[k] + axis], value);
      const got = occlusionCull(h, occCam, pyr);
      const broken = new Set(ks);
      for (const k of ks) assert.equal(got[k], 1, `리프 ${k}: 비유한 점 좌표 리프는 남겨야 함`);
      for (let j = 0; j < base.length; j++) if (!broken.has(j)) assert.equal(got[j], base[j], `다른 리프 ${j} 가 변함`);
    });
  }
}

// 가려진 리프(정상 마스크 0): 점 하나의 좌표가 비유한이면 그 리프는 남아야 한다(빈 상자 = 판정 포기).
// 비유한 점을 리프의 마지막 점에 두어, 앞쪽 유한 점들로 만든 부분 상자가 남으면(상자 초기화 누락) 여전히 가려진 것으로 판정되어 제거되도록 한다.
for (const [label, value] of [['NaN', NaN], ['Inf', Infinity], ['-Inf', -Infinity]]) {
  for (const axis of COORDS) {
    test(`occlusionCull × ${label} 점 좌표(가려진 리프, ${AXIS[axis]}): 남김 = 1`, () => {
      const { h: oh, pyr, base } = occlusionScene();
      const lv0 = oh.levels[0], ls = lv0.leafStart;
      const ks = [];
      for (let k = 0; k < base.length; k++) if (base[k] === 0 && ls[k + 1] - ls[k] > 1) ks.push(k);
      assert.ok(ks.length > 0, '가려진 리프가 없으면 상자 초기화를 변별하지 못함');
      const positions = new Float32Array(lv0.positions);
      for (const k of ks) positions[3 * (ls[k + 1] - 1) + axis] = value;
      const h = { ...oh, levels: [{ ...lv0, positions }, ...oh.levels.slice(1)] };
      const got = occlusionCull(h, occCam, pyr);
      const broken = new Set(ks);
      for (const k of ks) assert.equal(got[k], 1, `리프 ${k}: 가려진 리프라도 비유한 점이 있으면 남겨야 함`);
      for (let j = 0; j < base.length; j++) if (!broken.has(j)) assert.equal(got[j], base[j], `다른 리프 ${j} 가 변함`);
    });
  }
}

// 판정 포기 = 남김: 카메라 뒤(점 전부 z <= 0)에 있는 리프는 투영할 수 없으므로 정상 입력에서도 남아야 한다(occlusionCull 의 포기 분기).
// 장면 한가운데에서 +x·-x 방향을 보는 카메라로, 뒤쪽 리프가 실제로 있고(변별력) 그 리프가 모두 1 인지 단언한다.
for (const target of [[1, 20, 0], [-1, 20, 0]]) {
  test(`occlusionCull × 카메라 뒤 리프: 남김 = 1 (시선 ${target[0] > 0 ? '+x' : '-x'})`, () => {
    const { h } = occlusionScene();
    const cam = viewpointToCamera({ eye: [0, 20, 0], target, up: [0, 1, 0], fov_y_deg: 50, width: 320, height: 180 });
    const got = occlusionCull(h, cam, buildDepthPyramid(h, cam, { size: 64, pointSizeM: 0.75 }));
    const lv = h.levels[0], pos = lv.positions, R = cam.R, t = cam.t;
    let behind = 0;
    for (let k = 0; k < h.octree.leafCount; k++) {
      let zmax = -Infinity;
      for (let i = lv.leafStart[k]; i < lv.leafStart[k + 1]; i++) zmax = Math.max(zmax, R[6] * pos[3 * i] + R[7] * pos[3 * i + 1] + R[8] * pos[3 * i + 2] + t[2]);
      if (zmax <= 0) { behind++; assert.equal(got[k], 1, `리프 ${k}: 카메라 뒤 리프는 남겨야 함`); }
    }
    assert.ok(behind > 0, '카메라 뒤 리프가 없으면 포기 분기를 시험하지 못함');
  });
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
