// F-449 ⑥⑦⑧ 경계 시험. 수치 기대값은 손계산으로 시험 안에 박았다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerFallback } from './index.mjs';
import { fitView } from './view.mjs';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const finiteXY = (m) => Number.isFinite(m.x) && Number.isFinite(m.y);
const drone = (id, e, n) => ({ id, enu: [e, n, 0] });

test('edge ⑥: 하한 미만 span 은 metersPerPx 하한 1e-6 으로 고정되고 frame 이 던지지 않는다', () => {
  for (const minSpanM of [1e-3, 1e-6]) {
    const f = createTowerFallback({ minSpanM });
    f.setAvailable(false);
    f.setDrones([drone('a', 10, 20)]);
    const fr = f.frame({ width: 1920, height: 1080 });
    // side 1080, m 16, avail 1048. span/avail = 1e-3/1048 ≈ 9.54e-7 (또는 1e-6/1048 ≈ 9.54e-10) < 1e-6 → 1e-6.
    assert.equal(fr.view.metersPerPx, 1e-6);
    assert.equal(fr.view.centerE, 10);
    assert.equal(fr.view.centerN, 20);
    assert.ok(finiteXY(fr.drones[0]));
    assert.equal(fr.drones[0].x, 960);
    assert.equal(fr.drones[0].y, 540);
    assert.equal(fr.drones[0].visible, true);
  }
  // 점 둘: (0,0),(0.001,0) → span 1e-3, 1e-3/1048 < 1e-6 → 1e-6. center (0.0005, 0).
  // (0.001,0): x = 960 + 0.0005/1e-6 = 1460, (0,0): x = 460, y = 540.
  const f = createTowerFallback({ minSpanM: 1e-6 });
  f.setAvailable(false);
  f.setDrones([drone('a', 0, 0), drone('b', 0.001, 0)]);
  const fr = f.frame({ width: 1920, height: 1080 });
  assert.equal(fr.view.metersPerPx, 1e-6);
  assert.ok(near(fr.drones[0].x, 460) && near(fr.drones[1].x, 1460));
  assert.ok(fr.drones.every((d) => finiteXY(d) && d.y === 540 && d.visible));
  // 하한 미만이 아니면 그대로: (0,0),(200,100) 800×600 → 200/568.
  assert.ok(near(fitView([[0, 0], [200, 100]], { width: 800, height: 600 }, { minSpanM: 100, marginPx: 16 }).metersPerPx, 200 / 568, 1e-15));
  // 직접 호출도 던지지 않고 하한으로 고정.
  assert.equal(fitView([[0, 0]], { width: 800, height: 600 }, { minSpanM: 5e-324, marginPx: 16 }).metersPerPx, 1e-6);
});

test('edge ⑦: setView 의 |centerE|,|centerN| 이 maxAbsEnuM(1e6) 을 넘으면 RangeError', () => {
  const f = createTowerFallback();
  f.setAvailable(false);
  f.setDrones([drone('a', -1e6, 0)]);
  f.setView({ centerE: 1e6, centerN: -1e6, metersPerPx: 1e-6 }); // 경계 포함
  const before = f.frame({ width: 100, height: 100 });
  // x = 50 + (−1e6 − 1e6)/1e-6 = 50 − 2e12
  assert.ok(near(before.drones[0].x, 50 - 2e12, 1e-2));
  assert.ok(finiteXY(before.drones[0]));
  for (const bad of [
    { centerE: 1e308, centerN: -1e308, metersPerPx: 1e-6 },
    { centerE: 1e6 + 1, centerN: 0, metersPerPx: 1 },
    { centerE: 0, centerN: -1e6 - 1, metersPerPx: 1 },
    { centerE: -1e6 - 1, centerN: 0, metersPerPx: 1 },
  ]) {
    assert.throws(() => f.setView(bad), RangeError);
  }
  // 던진 뒤 이전 view 가 그대로다.
  assert.deepEqual(f.frame({ width: 100, height: 100 }), before);
});

test('edge ⑧: 한 변 < 4px 의 여백은 m = side/4 < 1 이고 한 변 ≥ 2px 에서 모든 점이 visible', () => {
  const pts = [[0, 0], [10, 10]];
  const run = (side, marginPx) => {
    const v = fitView(pts, { width: side, height: side }, { minSpanM: 1, marginPx });
    const hi = { x: side / 2 + 5 / v.metersPerPx, y: side / 2 - 5 / v.metersPerPx };
    const lo = { x: side / 2 - 5 / v.metersPerPx, y: side / 2 + 5 / v.metersPerPx };
    return { v, hi, lo };
  };
  // side 2: m = min(16, 0.5) = 0.5, avail = 1, mpp = 10. (10,10) → (1.5, 0.5), (0,0) → (0.5, 1.5).
  let r = run(2, 16);
  assert.equal(r.v.metersPerPx, 10);
  assert.deepEqual([r.hi.x, r.hi.y, r.lo.x, r.lo.y], [1.5, 0.5, 0.5, 1.5]);
  // side 3, marginPx 0: m = 0.75, avail = 1.5, mpp = 10/1.5. 끝 x = 1.5 + 0.75 = 2.25 (< 3 이지만 > size−1 = 2).
  r = run(3, 0);
  assert.ok(near(r.v.metersPerPx, 10 / 1.5, 1e-12));
  assert.ok(near(r.hi.x, 2.25, 1e-12) && near(r.lo.x, 0.75, 1e-12));
  // side 4, marginPx 0: m = min(1, 1) = 1, avail = 2, mpp = 5. 끝 x = 2 + 1 = 3 = size−1.
  r = run(4, 0);
  assert.equal(r.v.metersPerPx, 5);
  assert.ok(r.hi.x === 3 && r.lo.x === 1);
  // side 1: m = 0.25, avail = max(0.5, 1) = 1, mpp = 10. 끝 x = 0.5 + 0.5 = 1 = width → 보이지 않는다(그래서 '한 변 ≥ 2').
  r = run(1, 16);
  assert.equal(r.hi.x, 1);
  // frame 으로도 확인: 2×2, 점 둘 모두 visible.
  const f = createTowerFallback({ minSpanM: 1, marginPx: 16 });
  f.setAvailable(false);
  f.setDrones([drone('a', 0, 0), drone('b', 10, 10)]);
  const fr = f.frame({ width: 2, height: 2 });
  assert.deepEqual(fr.drones.map((d) => [d.x, d.y, d.visible]), [[0.5, 1.5, true], [1.5, 0.5, true]]);
});
