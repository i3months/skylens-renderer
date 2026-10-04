// gapCellError 의 분기한정 분할과 칸 예산 소진 거부를 지키는 시험.
// 기준값은 아래 기하에서 손으로 구한 리터럴이다(구현을 읽어 되받지 않는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { gapCellError } from './index.mjs';

// 축 정렬 직사각형 구성 건물(toFrame 이 만드는 요소와 같은 필드: 상자, 넓이 있는 삼각형 fill, 변 선분 segs).
const member = (x0, y0, x1, y1) => ({
  minX: x0, minY: y0, maxX: x1, maxY: y1,
  fill: Float64Array.from([x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1]),
  segs: Float64Array.from([x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0]),
});

// 배치 1: 칸 [0,4]×[0,4], 한가운데에 1×1 건물 S=[1.5,2.5]². 칸 중심 (2,2) 는 S 안이라 e=0, w=0 (한도 1 이하).
// 그러나 모서리 (4,0): S 까지 거리 hypot(1.5,1.5)≈2.12, 합친 상자 경계 위라 x=0 → w=e≈2.12 > 1.
// 루트 칸을 중심 w 로만 수용하는 구현(분할 없음)은 통과시키고, 분기한정은 쪼개서 거절해야 한다.
test('칸 중심은 한도 이하이고 모서리는 초과: 분할하여 거절', () => {
  const S = member(1.5, 1.5, 2.5, 2.5);
  const box = { minX: 0, minY: 0, maxX: 4, maxY: 4 };
  assert.equal(gapCellError(0, 0, 4, 4, [S], 1, box, { cells: 1 << 14 }), null);
});

// 배치 2: 끼인 틈 [1,2]×[0,2] (A=[0,1]×[0,2], B=[2,3]×[0,2], 합친 상자 [0,3]×[0,2]), 한도 1 = 틈 폭.
// 중심선 x=1.5 위에서 e=0.5, w=min(2e, e+x)=1 ≤ 1 이라 수용되며 e 상한은 0.5 이다.
// 루트 칸의 상계는 한도를 넘으므로 쪼개야 하고(루트 + 자식 4칸), 예산이 충분하면 {e:0.5, w:1} 로 끝난다.
const A = member(0, 0, 1, 2), B = member(2, 0, 3, 2);
const gapBox = { minX: 0, minY: 0, maxX: 3, maxY: 2 };

test('끼인 틈 폭 = 한도: 예산이 충분하면 수용(e, w 상한 리터럴)', () => {
  const g = gapCellError(1, 0, 2, 2, [A, B], 1, gapBox, { cells: 1 << 14 });
  assert.deepEqual(g, { e: 0.5, w: 1 });
});

test('칸 예산 소진: 같은 칸이 예산 부족이면 거절(null)', () => {
  // 예산 1: 루트 한 칸만 허용되는데 루트는 쪼개야 하므로 자식 칸에서 소진 → 거절.
  assert.equal(gapCellError(1, 0, 2, 2, [A, B], 1, gapBox, { cells: 1 }), null);
  // 예산 0: 루트 칸부터 소진 → 거절.
  assert.equal(gapCellError(1, 0, 2, 2, [A, B], 1, gapBox, { cells: 0 }), null);
  // 소진 직전 경계: 루트 1칸 + 자식 4칸 = 5칸이면 수용하고 4칸이면 거절.
  assert.deepEqual(gapCellError(1, 0, 2, 2, [A, B], 1, gapBox, { cells: 5 }), { e: 0.5, w: 1 });
  assert.equal(gapCellError(1, 0, 2, 2, [A, B], 1, gapBox, { cells: 4 }), null);
});
