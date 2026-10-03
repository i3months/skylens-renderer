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

// F-102 ①: 평면 네 개 각각의 경계 직전·경계·직후·완전히 밖. 모든 상자는 z = 9 의 얇은 판(mn.z = mx.z = 9)이다.
// 손계산(fx = fy = 90, cx = 160, cy = 90, W = 320, H = 180, z = 9):
//   왼쪽  90x + 160·9 ≥ 0   ⇔ x ≥ −16        오른쪽  90x + (160 − 320)·9 ≤ 0 ⇔ x ≤ 16
//   위    90y +  90·9 ≥ 0   ⇔ y ≥ −9         아래    90y + (90 − 180)·9  ≤ 0 ⇔ y ≤ 9
// 경계 값이 모두 정수라 부동소수 오차 없이 등호가 정확히 0 이 된다. 시험 상자는 다른 평면에는 확실히 안쪽이다.
const slab = (x0, x1, y0, y1) => [CAM, [x0, y0, 9], [x1, y1, 9]];

test('boxMayBeVisible: 오른쪽 평면 x = 16 (직전·경계·직후·완전히 밖)', () => {
  assert.equal(boxMayBeVisible(...slab(16.001, 17, 0, 1)), false, '직후(최소 x 16.001)');
  assert.equal(boxMayBeVisible(...slab(16, 17, 0, 1)), true, '경계(최소 x = 16, 등호는 안)');
  assert.equal(boxMayBeVisible(...slab(15.999, 17, 0, 1)), true, '직전(최소 x 15.999)');
  assert.equal(boxMayBeVisible(...slab(20, 21, 0, 1)), false, '완전히 밖');
  assert.equal(boxMayBeVisible(...slab(10, 11, 0, 1)), true, '안쪽 상자');
});

test('boxMayBeVisible: 왼쪽 평면 x = −16 (직전·경계·직후·완전히 밖)', () => {
  assert.equal(boxMayBeVisible(...slab(-17, -16.001, 0, 1)), false, '직후(최대 x −16.001)');
  assert.equal(boxMayBeVisible(...slab(-17, -16, 0, 1)), true, '경계(최대 x = −16)');
  assert.equal(boxMayBeVisible(...slab(-17, -15.999, 0, 1)), true, '직전(최대 x −15.999)');
  assert.equal(boxMayBeVisible(...slab(-21, -20, 0, 1)), false, '완전히 밖');
});

test('boxMayBeVisible: 위 평면 y = −9 (직전·경계·직후·완전히 밖)', () => {
  assert.equal(boxMayBeVisible(...slab(0, 1, -10, -9.001)), false, '직후(최대 y −9.001)');
  assert.equal(boxMayBeVisible(...slab(0, 1, -10, -9)), true, '경계(최대 y = −9)');
  assert.equal(boxMayBeVisible(...slab(0, 1, -10, -8.999)), true, '직전(최대 y −8.999)');
  assert.equal(boxMayBeVisible(...slab(0, 1, -20, -15)), false, '완전히 밖');
});

test('boxMayBeVisible: 아래 평면 y = 9 (직전·경계·직후·완전히 밖)', () => {
  assert.equal(boxMayBeVisible(...slab(0, 1, 9.001, 10)), false, '직후(최소 y 9.001)');
  assert.equal(boxMayBeVisible(...slab(0, 1, 9, 10)), true, '경계(최소 y = 9)');
  assert.equal(boxMayBeVisible(...slab(0, 1, 8.999, 10)), true, '직전(최소 y 8.999)');
  assert.equal(boxMayBeVisible(...slab(0, 1, 15, 20)), false, '완전히 밖');
});

test('boxMayBeVisible: 네 평면 밖 상자는 select·budget 에서도 NOT_DRAWN, 안쪽은 그려짐', () => {
  // z 20..20.001 판, 점 두 개. 평면 값은 z = 20 에서 x ∈ [−35.55.., 35.55..], y ∈ [−20, 20].
  const mk = (x, y) => {
    const pts = [x, y, 20, x + 0.001, y + 0.001, 20.001];
    const cloud = { format: 1, count: 2, positions: Float32Array.from(pts), normals: new Float32Array(6), colors: new Uint8Array(6) };
    return buildHierarchy(cloud, { edge0M: 0.25, levelCount: 3, maxLeafPoints: 64 });
  };
  for (const [name, x, y, vis] of [
    ['오른쪽 밖(x 60)', 60, 0, false], ['왼쪽 밖(x −60)', -60, 0, false],
    ['위 밖(y −40)', 0, -40, false], ['아래 밖(y 40)', 0, 40, false], ['안', 0, 0, true],
  ]) {
    const h = mk(x, y);
    const a = selectLevels(h, CAM, { thresholdPx: 1 }).leafLevel[0];
    const b = selectWithBudget(h, CAM, { budgetPoints: 1000, thresholdPx: 1 }).leafLevel[0];
    assert.equal(a !== NOT_DRAWN, vis, `select ${name}`);
    assert.equal(b !== NOT_DRAWN, vis, `budget ${name}`);
    assert.equal(progressiveChunks(h, CAM, { thresholdPx: 1 }).length > 0, vis, `progressive ${name}`);
  }
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
