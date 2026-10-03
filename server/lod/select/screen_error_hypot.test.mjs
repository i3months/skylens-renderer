// F-104 ① 확인: minCosToAxis 의 r = |p| 가 제곱 넘침 없이 계산된다(좌표 1e200 에서도 cos α 가 0 으로 무너지지 않음).
// 기준값: 같은 상자를 축척 1 에서 잰 cos α. cos α = z/r 는 축척에 무관하므로 1e200 배 상자에서도 같아야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { minCosToAxis, boxDistanceM, screenErrorRule } from './screen_error.mjs';

const CAM = { width: 320, height: 180, K: { fx: 90, fy: 90, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const scaled = (v, s) => v.map((x) => x * s);

test('minCosToAxis: 1e200 배 상자의 cos α 가 축척 1 과 같다(넘침 없음)', () => {
  const mn = [1, 1, 1], mx = [2, 2, 3];
  const ref = minCosToAxis(CAM, mn, mx);
  assert.ok(Math.abs(ref - 1 / 3) < 1e-12, `기준 ${ref}`); // 꼭짓점 (2,2,1): 1/√(4+4+1)
  for (const s of [1e150, 1e200, 1e300]) {
    const c = minCosToAxis(CAM, scaled(mn, s), scaled(mx, s));
    assert.ok(c > 0, `축척 ${s}: cos ${c}`);
    assert.ok(Math.abs(c - ref) < 1e-12, `축척 ${s}: ${c} ≠ ${ref}`);
  }
});

test('minCosToAxis: 아주 작은 좌표(1e-200)에서도 같은 값(밑넘침 없음)', () => {
  const mn = [1, 1, 1], mx = [2, 2, 3];
  const ref = minCosToAxis(CAM, mn, mx);
  const c = minCosToAxis(CAM, scaled(mn, 1e-200), scaled(mx, 1e-200));
  assert.ok(Math.abs(c - ref) < 1e-12, `${c} ≠ ${ref}`);
});

test('boxDistanceM: 1e200 좌표에서 유한하고 축척에 비례', () => {
  const d = boxDistanceM([0, 0, 0], scaled([3, 4, 12], 1e200), scaled([5, 5, 13], 1e200));
  assert.ok(Number.isFinite(d) && Math.abs(d / 13e200 - 1) < 1e-12, `d ${d}`);
});

// 옛 구현은 거리가 Infinity 로 넘쳐 levelForDistance 가 던졌다.
test('screenErrorRule.leaf: 1e200 거리의 리프는 cosMin > 0, 가장 거친 단계', () => {
  const rule = screenErrorRule(CAM, { thresholdPx: 0.5, edge0M: 0.05, levelCount: 5 });
  const e = rule.leaf(scaled([1, 1, 1], 1e200), scaled([2, 2, 3], 1e200));
  assert.ok(Math.abs(e.cosMin - 1 / 3) < 1e-12, `cosMin ${e.cosMin}`);
  assert.ok(e.effDistM > 0);
  assert.equal(e.level, 4);
});
