// F-100 ⑨: 시야 판정 공용 함수(view_check.mjs) 시험. select·budget·progressive 가 같은 경계 규칙을 쓴다.
// 경계 규칙: 앞은 z > 0(1e-6 같은 하한 없음, z = 0 은 밖), 좌·우·위·아래는 등호를 안으로 본다.
// 카메라: R = I, t = 0, 320×180, fx = fy = 90, cx = 160, cy = 90 (z 가 곧 깊이).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMayBeVisible } from './view_check.mjs';
import { selectLevels, buildHierarchy } from './index.mjs';
import { selectWithBudget, leafTargets } from '../budget/index.mjs';
import { progressiveChunks } from '../progressive/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';

const CAM = { width: 320, height: 180, K: { fx: 90, fy: 90, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

// 점 몇 개로 이루어진 한 리프 계층. zMax 가 상자의 가장 앞쪽 z.
function oneLeafHierarchy(zMin, zMax) {
  const pts = [0, 0, zMin, 0.001, 0.001, zMin, 0, 0, zMax, 0.001, 0.001, zMax];
  const n = pts.length / 3;
  const cloud = { format: 1, count: n, positions: Float32Array.from(pts), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) };
  return buildHierarchy(cloud, { edge0M: 0.25, levelCount: 3, maxLeafPoints: 64 });
}

test('boxMayBeVisible: 앞 경계는 z > 0 (z = 0 은 밖, 1e-7 앞은 안)', () => {
  assert.equal(boxMayBeVisible(CAM, [0, 0, -1], [0.001, 0.001, 0]), false);
  assert.equal(boxMayBeVisible(CAM, [0, 0, -1], [0.001, 0.001, 1e-7]), true);
  assert.equal(boxMayBeVisible(CAM, [0, 0, -1], [0.001, 0.001, 5e-7]), true);
  assert.equal(boxMayBeVisible(CAM, [-1, -1, -3], [1, 1, -1]), false);
});

test('boxMayBeVisible: 좌 경계(u = 0)의 등호는 안, 바깥은 밖', () => {
  // z = 10 에서 u = 90·x/10 + 160 = 0 ⇔ x = −160/9. 상자의 오른쪽 면이 정확히 그 값이면 안.
  const x = -160 / 9;
  assert.equal(boxMayBeVisible(CAM, [x - 1, 0, 10], [x, 0.1, 10.5]), true);
  assert.equal(boxMayBeVisible(CAM, [x - 1, 0, 10], [x - 0.01, 0.1, 10]), false);
});

test('경계 통일: 앞쪽 z = 5e-7 만 걸친 리프를 select·budget·progressive 모두 버리지 않음', () => {
  const h = oneLeafHierarchy(-1, 5e-7);
  const sel = selectLevels(h, CAM, { thresholdPx: 1 });
  assert.notEqual(sel.leafLevel[0], NOT_DRAWN);
  const t = leafTargets(h, CAM, 1);
  assert.equal(t.visible[0], 1);
  const b = selectWithBudget(h, CAM, { budgetPoints: 1000, thresholdPx: 1 });
  assert.notEqual(b.leafLevel[0], NOT_DRAWN);
  assert.ok(progressiveChunks(h, CAM, { thresholdPx: 1 }).length > 0, 'progressive 도 조각을 낸다(이전에는 z < 1e-6 이라 버렸음)');
});

test('경계 통일: 전부 z ≤ 0 인 리프는 세 모듈 모두 그리지 않음', () => {
  const h = oneLeafHierarchy(-1, 0);
  assert.equal(selectLevels(h, CAM, { thresholdPx: 1 }).leafLevel[0], NOT_DRAWN);
  assert.equal(leafTargets(h, CAM, 1).visible[0], 0);
  assert.equal(selectWithBudget(h, CAM, { budgetPoints: 1000, thresholdPx: 1 }).leafLevel[0], NOT_DRAWN);
  assert.equal(progressiveChunks(h, CAM, { thresholdPx: 1 }).length, 0);
});

test('카메라 오류 접두: select·budget(leafTargets 포함)·progressive 모두 "lod:"', () => {
  const h = oneLeafHierarchy(1, 2);
  const bad = { ...CAM, K: { ...CAM.K, fx: -1 } };
  for (const fn of [
    () => selectLevels(h, bad, { thresholdPx: 1 }),
    () => selectWithBudget(h, bad, { budgetPoints: 10, thresholdPx: 1 }),
    () => leafTargets(h, bad, 1),
    () => progressiveChunks(h, bad, { thresholdPx: 1 }),
  ]) {
    assert.throws(fn, (e) => e.message.startsWith('lod:'), String(fn));
  }
});
