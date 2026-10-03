// F-104 ④ 점 0개 리프의 표현 통일: select 와 budget 모두 NOT_DRAWN.
// 점이 없는 리프는 그릴 것이 없다. 단계 0 으로 표시하면 같은 입력에서 두 선택기의 leafLevel 이 갈려
// "그려진 리프" 의 의미가 흐려진다. 점 수는 어느 쪽이든 0 이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { buildHierarchy, selectLevels, materialize } from './index.mjs';
import { selectWithBudget } from '../budget/index.mjs';

const CAM = { width: 320, height: 180, K: { fx: 90, fy: 90, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

// 팔진 트리는 점이 있는 자식만 리프로 만들므로 점 0개 리프는 빈 점군의 루트 리프뿐이다(octree/index.mjs).
// 카메라 좌표 z = 5 > 0 으로 두어 루트 상자가 시야 안에 오게 한다.
const CAM_FRONT = { ...CAM, t: [0, 0, 5] };
function emptyCloud() {
  return { format: 1, count: 0, positions: new Float32Array(0), normals: new Float32Array(0), colors: new Uint8Array(0) };
}

test('점 0개 리프: select 와 budget 모두 NOT_DRAWN, 점 수 일치', () => {
  const h = buildHierarchy(emptyCloud(), { edge0M: 0.05, levelCount: 3 });
  const empty = [];
  for (let k = 0; k < h.octree.leafCount; k++) if (h.levels[0].leafStart[k + 1] === h.levels[0].leafStart[k]) empty.push(k);
  assert.ok(empty.length > 0, '시험 전제: 점 0개 리프가 있어야 한다');

  const sel = selectLevels(h, CAM_FRONT, { thresholdPx: 0.5 });
  const bud = selectWithBudget(h, CAM_FRONT, { budgetPoints: 1e9, thresholdPx: 0.5 });
  for (const k of empty) {
    assert.equal(sel.leafLevel[k], NOT_DRAWN, `select 리프 ${k}`);
    assert.equal(bud.leafLevel[k], NOT_DRAWN, `budget 리프 ${k}`);
  }
  assert.deepEqual(sel.leafLevel, bud.leafLevel);
  assert.equal(sel.pointCount, bud.pointCount);
  assert.equal(materialize(h, sel).count, sel.pointCount);
});
