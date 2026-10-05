// 병합 단위(mergeError)의 틈 칸 예산 소진 거부를 지키는 시험(F-348).
// 새 칸 예산과 이어받은 칸 재측정 예산은 각각 16384 칸이다. 예산이 소진되면 병합을 거부한다.
// 아래 배치는 기하로는 1개로 합쳐도 맞지만 예산 소진으로 거부(안전한 쪽)되어 상자가 2개가 된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingLod } from './index.mjs';
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
