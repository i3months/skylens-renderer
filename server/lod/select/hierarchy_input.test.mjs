// F-107 ①②: 계층 입력 검사 통일(select·budget·progressive 공용)과 budget 의 가시성 판정 순서 시험.
// 잘못된 입력(nodeCount 없음, 길이 불일치, 타입 오류)은 selectLevels·selectWithBudget 모두 'lod:' 예외.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { buildHierarchy, selectLevels, assertHierarchyInput } from './index.mjs';
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
  'nodeCount 없음': (h) => { delete h.octree.nodeCount; },
  'nodeCount 가 정수 아님': (h) => { h.octree.nodeCount = 1.5; },
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
    let h;
    try { h = mutate(fn); } catch { h = null; }
    assert.throws(() => selectLevels(h, camera, OPTS), /^Error: lod:/);
    assert.throws(() => selectWithBudget(h, camera, { ...OPTS, budgetPoints: 100 }), /^Error: lod:/);
    assert.throws(() => assertHierarchyInput(h), /^Error: lod:/);
  });
}

test('budget: d 가 Infinity 인 리프도 던지지 않고 select 와 같은 빈 결과', () => {
  // 한 리프 상자를 비유한(Infinity) 좌표로 바꿔 시야 밖으로 만든다.
  const h = mutate(() => {});
  h.octree.boxMin = Float32Array.from(base.octree.boxMin);
  h.octree.boxMax = Float32Array.from(base.octree.boxMax);
  for (let a = 0; a < 3; a++) { h.octree.boxMin[a] = Infinity; h.octree.boxMax[a] = Infinity; }
  const s = (() => { try { return selectLevels(h, camera, OPTS); } catch (e) { return e; } })();
  const b = (() => { try { return selectWithBudget(h, camera, { ...OPTS, budgetPoints: 1e9 }); } catch (e) { return e; } })();
  assert.equal(s instanceof Error, b instanceof Error, `select 와 budget 의 던짐 여부 일치: ${String(s)} / ${String(b)}`);
  if (!(s instanceof Error)) assert.deepEqual(Array.from(b.leafLevel), Array.from(s.leafLevel));
});
