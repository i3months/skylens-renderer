// F-107 ①②: 계층 입력 검사 통일(select·budget·progressive 공용)과 budget 의 가시성 판정 순서 시험.
// 잘못된 입력(nodeCount 없음, 길이 불일치, 타입 오류)은 selectLevels·selectWithBudget 모두 'lod:' 예외.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { buildHierarchy, selectLevels, assertHierarchyInput } from './index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { selectWithBudget, assertHierarchyInput as fromBudget } from '../budget/index.mjs';

const { cloud } = generate({ seed: 1, count: 3000 });
const base = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 256 });
const camera = viewpointToCamera({ eye: [0, 120, 140], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 });
const OPTS = { thresholdPx: 0.5 };

// 계층의 얕은 사본에 변형을 적용한다(원본은 건드리지 않음).
function mutate(fn) {
  const h = { ...base, octree: { ...base.octree }, levels: base.levels.map((l) => ({ ...l })) };
  fn(h);
  return h;
}

const BAD = {
  'leafIndex 길이 불일치': (h) => { h.octree.leafIndex = h.octree.leafIndex.subarray(1); },
  'boxMin 길이 불일치': (h) => { h.octree.boxMin = h.octree.boxMin.subarray(3); },
  'boxMax 길이 불일치': (h) => { h.octree.boxMax = h.octree.boxMax.subarray(0, h.octree.boxMax.length - 3); },
  'boxMin 타입 오류': (h) => { h.octree.boxMin = Array.from(h.octree.boxMin); },
  'leafIndex 타입 오류': (h) => { h.octree.leafIndex = Int16Array.from(h.octree.leafIndex); },
  'normals 길이 불일치': (h) => { h.levels[1].normals = h.levels[1].normals.subarray(3); },
  'normals 타입 오류': (h) => { h.levels[0].normals = new Float64Array(h.levels[0].normals); },
  'colors 길이 불일치': (h) => { h.levels[1].colors = h.levels[1].colors.subarray(3); },
  'colors 타입 오류': (h) => { h.levels[0].colors = new Uint16Array(h.levels[0].colors); },
  'colors 없음': (h) => { delete h.levels[2].colors; },
  'positions 길이 불일치': (h) => { h.levels[1].positions = h.levels[1].positions.subarray(3); },
  'positions 타입 오류': (h) => { h.levels[0].positions = Array.from(h.levels[0].positions); },
};

test('올바른 계층은 통과하고 공용 함수는 같은 것', () => {
  assert.equal(fromBudget, assertHierarchyInput);
  assert.doesNotThrow(() => assertHierarchyInput(base));
  assert.doesNotThrow(() => selectLevels(base, camera, OPTS));
  assert.doesNotThrow(() => selectWithBudget(base, camera, { ...OPTS, budgetPoints: 1e9 }));
});

for (const [name, fn] of Object.entries(BAD)) {
  test(`잘못된 계층(${name}) 은 selectLevels·selectWithBudget 모두 'lod:' 예외`, () => {
    const h = mutate(fn);
    assert.throws(() => selectLevels(h, camera, OPTS), /^Error: lod:/);
    assert.throws(() => selectWithBudget(h, camera, { ...OPTS, budgetPoints: 100 }), /^Error: lod:/);
    assert.throws(() => assertHierarchyInput(h), /^Error: lod:/);
  });
}

// nodeCount 검사(select/index.mjs 의 'leafCount 이상의 정수')를 길이 검사와 구별해 시험한다.
// 길이 불일치 메시지에는 leafCount 가 없으므로 /nodeCount.*leafCount/ 는 nodeCount 검사에서만 나온다.
const NODE_COUNT_MSG = /^Error: lod:.*nodeCount.*leafCount/;
const NODE_COUNT_BAD = {
  'nodeCount 없음': (h) => { delete h.octree.nodeCount; },
  'nodeCount 가 정수 아님': (h) => { h.octree.nodeCount = 1.5; },
  // 배열 길이는 실제 nodeCount 그대로이고 nodeCount 값만 leafCount−1 로 어긋난 경우
  'nodeCount = leafCount−1 (길이는 일치)': (h) => { h.octree.nodeCount = h.octree.leafCount - 1; },
};
for (const [name, fn] of Object.entries(NODE_COUNT_BAD)) {
  test(`nodeCount 검사 독립 확인(${name}): 세 경로 모두 nodeCount·leafCount 를 말하는 'lod:' 예외`, () => {
    const h = mutate(fn);
    assert.throws(() => selectLevels(h, camera, OPTS), NODE_COUNT_MSG);
    assert.throws(() => selectWithBudget(h, camera, { ...OPTS, budgetPoints: 100 }), NODE_COUNT_MSG);
    assert.throws(() => assertHierarchyInput(h), NODE_COUNT_MSG);
  });
}

test('budget: d 가 비유한(오버플로)인 실제 리프도 던지지 않고 그 리프는 NOT_DRAWN', () => {
  const { octree, levels } = base;
  const full = selectLevels(base, camera, OPTS);
  // 실제 리프(leafIndex ≥ 0)이고 점이 있으며 원래 그려지는 노드를 고른다(루트 아님).
  let node = -1;
  for (let n = 0; n < octree.nodeCount; n++) {
    const k = octree.leafIndex[n];
    if (k >= 0 && levels[0].leafStart[k + 1] > levels[0].leafStart[k] && full.leafLevel[k] !== NOT_DRAWN) { node = n; break; }
  }
  assert.ok(node > 0, '시험할 실제 리프 노드를 찾음');
  const k = octree.leafIndex[node];
  // 상자는 유한하게 두고(비유한 상자는 입력 검사가 거부한다) 카메라 이동을 double 최댓값 근처로 키워
  // 리프까지의 거리 제곱합이 오버플로(Infinity)되게 한다.
  const far = { ...camera, t: [1.7e308, 1.7e308, 1.7e308] };
  let s, b;
  assert.doesNotThrow(() => { s = selectLevels(base, far, OPTS); });
  assert.doesNotThrow(() => { b = selectWithBudget(base, far, { ...OPTS, budgetPoints: 1e9 }); });
  assert.equal(s.leafLevel[k], NOT_DRAWN, 'selectLevels: 그 리프는 NOT_DRAWN');
  assert.equal(b.leafLevel[k], NOT_DRAWN, 'budget: 그 리프는 NOT_DRAWN');
});

test('비유한 상자는 입력 검사가 두 경로 모두에서 \'lod:\' 로 거부한다', () => {
  const { octree } = base;
  let node = -1;
  for (let n = 1; n < octree.nodeCount; n++) if (octree.leafIndex[n] >= 0) { node = n; break; }
  const h = mutate(() => {});
  h.octree.boxMax = Float32Array.from(octree.boxMax);
  h.octree.boxMax[3 * node] = Infinity;
  assert.throws(() => selectLevels(h, camera, OPTS), /^Error: lod:/);
  assert.throws(() => selectWithBudget(h, camera, { ...OPTS, budgetPoints: 1e9 }), /^Error: lod:/);
});
