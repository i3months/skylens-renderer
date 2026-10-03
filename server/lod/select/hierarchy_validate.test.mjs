// F-111 ⑧: assertHierarchyInput 의 값 검사(leafStart·leafIndex·상자). 정상 계층은 통과, 각 위반은 'lod:' 로 던진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { buildHierarchy, assertHierarchyInput } from './index.mjs';

const { cloud } = generate({ seed: 1, count: 3000 });
const base = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 256 });

// 배열까지 복사한 사본에 변형을 적용한다(원본 보존).
function mutate(fn) {
  const o = base.octree;
  const h = {
    ...base,
    octree: { ...o, leafIndex: o.leafIndex.slice(), boxMin: o.boxMin.slice(), boxMax: o.boxMax.slice() },
    levels: base.levels.map((l) => ({ ...l, leafStart: l.leafStart.slice() })),
  };
  fn(h);
  return h;
}

test('정상 계층은 던지지 않는다', () => {
  assert.doesNotThrow(() => assertHierarchyInput(base));
  assert.doesNotThrow(() => assertHierarchyInput(mutate(() => {})));
});

const BAD = {
  'leafIndex 가 리프 수 이상(99999)': (h) => { h.octree.leafIndex[h.octree.leafIndex.findIndex((v) => v >= 0)] = 99999; },
  'leafIndex 가 리프 수와 같음': (h) => { h.octree.leafIndex[h.octree.leafIndex.findIndex((v) => v >= 0)] = h.octree.leafCount; },
  'leafIndex 가 -2': (h) => { h.octree.leafIndex[0] = -2; },
  'leafStart 역순(감소)': (h) => { const ls = h.levels[0].leafStart; [ls[1], ls[2]] = [ls[2] + 1, ls[1]]; ls[1] = ls[2] + 1; },
  'leafStart 첫 값이 0 아님': (h) => { h.levels[1].leafStart[0] = 1; },
  'leafStart 끝이 점 수 초과': (h) => { const ls = h.levels[0].leafStart; ls[ls.length - 1] += 1; },
  'leafStart 끝이 점 수 미만': (h) => { const ls = h.levels[1].leafStart; ls[ls.length - 1] -= 1; },
  'boxMin NaN': (h) => { h.octree.boxMin[4] = NaN; },
  'boxMax NaN': (h) => { h.octree.boxMax[7] = NaN; },
  'boxMax Infinity': (h) => { h.octree.boxMax[2] = Infinity; },
  'boxMin > boxMax': (h) => { h.octree.boxMin[3] = h.octree.boxMax[3] + 1; },
};

for (const [name, fn] of Object.entries(BAD)) {
  test(`위반: ${name}`, () => {
    assert.throws(() => assertHierarchyInput(mutate(fn)), /^Error: lod:/);
  });
}
