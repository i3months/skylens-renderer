// 병합 단위(mergeError)의 틈 칸 예산 소진 거부를 지키는 시험(F-348).
// 새 칸 예산과 이어받은 칸 재측정 예산은 각각 16384 칸이다. 예산이 소진되면 병합을 거부한다.
// 마지막 시험(F-377)은 칸당 구성 건물 수가 많은 병합의 작업량을 계수로 지킨다.
// 아래 F-348 배치는 기하로는 1개로 합쳐도 맞지만 예산 소진으로 거부(안전한 쪽)되어 상자가 2개가 된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingLod, distStats } from './index.mjs';
import { prism } from './scene.mjs';

// 한 층 3 m. gap.test.mjs 와 같은 헬퍼.
const rect = (id, x0, y0, x1, y1) => ({ id, mesh: prism([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 1) });
// 출력의 상자 수(상자 하나 = 삼각형 10개).
const boxCount = (out) => out.reduce((n, g) => n + g.mesh.indices.length / 3 / 10, 0);

test('F-348: 5 km, 이어받은 칸 재측정 예산 소진이면 병합 거부(상자 2개)', () => {
  // 기하로는 1개가 맞지만 재측정 예산 소진으로 거부(안전한 쪽).
  const out = buildBuildingLod([rect(1, 0, 0, 2, 3), rect(2, 2, 1.2, 4, 4.2), rect(3, 4, 1.2, 10, 4.2), rect(4, 10, 0, 12, 3)], 5000);
  assert.deepEqual(out.flatMap((g) => g.ids).sort(), [1, 2, 3, 4]);
  assert.equal(boxCount(out), 2);
});

test('F-348: 5 km, 새 칸 예산 소진이면 병합 거부(상자 2개)', () => {
  // 기하로는 1개가 맞지만 새 칸 예산 소진으로 거부(안전한 쪽).
  const out = buildBuildingLod([rect(1, 0, 0, 2, 4.2), rect(2, 2, 1.2, 4, 3), rect(3, 4, 1.2, 10, 3)], 5000);
  assert.deepEqual(out.flatMap((g) => g.ids).sort(), [1, 2, 3]);
  assert.equal(boxCount(out), 2);
});

// F-377: 한 칸에 촘촘한 같은 높이 상자(0.6 m 상자, 0.7 m 간격, 40×40 = 1600개), 600 m.
// 예산(GAP_MAX_CELLS)은 칸 수만 막아서, 예전 gapCellError 는 칸마다 near 건물 전부를 훑어 병합 한 번이 칸 수 × near 였다
// (4000개 17.7 s, 지금 4.0 s). 벽시계 대신 계수로 판정한다: distStats.gapVisits / gapCells 는 칸 하나가 본 건물 수의 평균.
// 작성 때 잰 값은 약 10.1(색인), 색인을 빼고 near 전부를 훑으면 약 83. 한계 20 은 그 사이.
// 상자 수 24 는 고치기 전과 같다(색인은 결과를 바꾸지 않는다).
test('F-377: 한 칸 촘촘한 1600개, 틈 칸 하나가 보는 건물 수가 near 전부가 아니다', () => {
  const k = 40, bs = [];
  for (let i = 0; i < k * k; i++) {
    const x = (i % k) * 0.7, y = Math.floor(i / k) * 0.7;
    bs.push(rect(i + 1, x, y, x + 0.6, y + 0.6));
  }
  Object.assign(distStats, { gapCalls: 0, gapNear: 0, gapCells: 0, gapVisits: 0 });
  const out = buildBuildingLod(bs, 600);
  assert.equal(out.flatMap((g) => g.ids).length, k * k);
  assert.equal(boxCount(out), 24);
  assert.ok(distStats.gapCells > 100000, `틈 칸 계수가 돌아야 한다(양성 대조): ${distStats.gapCells}`);
  const perCell = distStats.gapVisits / distStats.gapCells;
  assert.ok(perCell <= 20, `칸당 건물 ${perCell.toFixed(1)} > 20`);
});
