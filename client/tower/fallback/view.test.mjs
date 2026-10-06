// 관제탑 폴백 지도 맞춤·화면 변환(view.mjs) 시험. 기준 수치는 손으로 계산해 시험 안에 박아 두었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitView, toScreen } from './view.mjs';
import { buildMarkers } from './markers.mjs';
import { createTowerFallback } from './index.mjs';
import { TOWER_FALLBACK_TEST_NAMES, TOWER_FALLBACK_LIMITS } from '../../../contracts/controlview/fallback.mjs';

const NAME_FIT = 'view: 맞춤은 받은 모든 점을 여백 안에 넣는다(숫자 박음)';
const NAME_NULL = 'view: 점이 없으면 null';
const PX_EPS = 1e-9;
const OPTS = { minSpanM: 100, marginPx: 16 };

test('view: 계약의 시험 이름과 일치한다', () => {
  assert.ok(TOWER_FALLBACK_TEST_NAMES.includes(NAME_FIT));
  assert.ok(TOWER_FALLBACK_TEST_NAMES.includes(NAME_NULL));
  assert.equal(TOWER_FALLBACK_LIMITS.minSpanM, OPTS.minSpanM);
  assert.equal(TOWER_FALLBACK_LIMITS.marginPx, OPTS.marginPx);
});

test(NAME_FIT, () => {
  const size = { width: 800, height: 600 };
  // 점 (0,0),(200,100): center (100,50), span 200, avail 600−32 = 568, metersPerPx 200/568.
  const v = fitView([[0, 0], [200, 100]], size, OPTS);
  assert.equal(v.centerE, 100);
  assert.equal(v.centerN, 50);
  assert.ok(Math.abs(v.metersPerPx - 200 / 568) < 1e-15);
  // (200,100): x = 400 + 100·2.84 = 684, y = 300 − 50·2.84 = 158. (0,0): x = 116, y = 442.
  const a = toScreen(v, size, 200, 100);
  assert.ok(Math.abs(a.x - 684) < PX_EPS && Math.abs(a.y - 158) < PX_EPS && a.visible);
  const b = toScreen(v, size, 0, 0);
  assert.ok(Math.abs(b.x - 116) < PX_EPS && Math.abs(b.y - 442) < PX_EPS && b.visible);

  // 점 1개: span = minSpanM, center = 그 점.
  const one = fitView([[-30, 70]], size, OPTS);
  assert.equal(one.centerE, -30);
  assert.equal(one.centerN, 70);
  assert.ok(Math.abs(one.metersPerPx - 100 / 568) < 1e-15);
  const s = toScreen(one, size, -30, 70);
  assert.ok(s.x === 400 && s.y === 300 && s.visible);

  // 폭이 더 작은 변이 기준: 800×300 → avail 268. 남북 폭 400 > 동서 폭 10.
  const wide = fitView([[0, 0], [10, 400]], { width: 800, height: 300 }, OPTS);
  assert.ok(Math.abs(wide.metersPerPx - 400 / 268) < 1e-15);

  // width < 2·marginPx 인 작은 크기: m = 20/4 = 5, avail = 10, metersPerPx = 200/10(1px 로 붕괴하지 않는다).
  const tiny = fitView([[0, 0], [200, 100]], { width: 20, height: 600 }, OPTS);
  assert.ok(Math.abs(tiny.metersPerPx - 200 / 10) < 1e-12);

  // 경계: x = width 는 보이지 않고 x = 0 은 보인다. y 는 북쪽이 위(작은 값).
  const view = { centerE: 0, centerN: 0, metersPerPx: 1 };
  const sz = { width: 100, height: 50 };
  assert.deepEqual(toScreen(view, sz, 50, 0), { x: 100, y: 25, visible: false });
  assert.deepEqual(toScreen(view, sz, -50, 25), { x: 0, y: 0, visible: true });
  assert.deepEqual(toScreen(view, sz, 0, -25), { x: 50, y: 50, visible: false });

  // 성질: 무작위 점 수천 개를 맞춘 뒤 모든 점이 [margin, size−margin] 안에 든다.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (const sizeCase of [{ width: 800, height: 600 }, { width: 300, height: 900 }, { width: 1920, height: 1080 }]) {
    const pts = [];
    for (let i = 0; i < 5000; i++) pts.push([(rnd() - 0.5) * 4000, (rnd() - 0.5) * 1500]);
    const fv = fitView(pts, sizeCase, OPTS);
    for (const [e, n] of pts) {
      const p = toScreen(fv, sizeCase, e, n);
      assert.ok(p.x >= 16 - PX_EPS && p.x <= sizeCase.width - 16 + PX_EPS, `x=${p.x}`);
      assert.ok(p.y >= 16 - PX_EPS && p.y <= sizeCase.height - 16 + PX_EPS, `y=${p.y}`);
      assert.equal(p.visible, true);
    }
  }

  // 큰 입력(점 10만 개)에서도 스택이 넘치지 않는다.
  const big = Array.from({ length: 100000 }, (_, i) => [i, -i]);
  const bv = fitView(big, size, OPTS);
  assert.equal(bv.centerE, 49999.5);
  assert.equal(bv.centerN, -49999.5);
  assert.ok(Math.abs(bv.metersPerPx - 99999 / 568) < 1e-12);
});

test(NAME_NULL, () => {
  assert.equal(fitView([], { width: 800, height: 600 }, OPTS), null);
});

test('view: marginPx=0 이어도 받은 모든 점이 visible 이고 끝 점은 size−1 이하', () => {
  const o0 = { minSpanM: 100, marginPx: 0 };
  for (const size of [{ width: 800, height: 600 }, { width: 300, height: 900 }, { width: 100, height: 100 }]) {
    // 지배 축이 동서·남북인 두 경우.
    for (const pts of [[[0, 0], [500, 10]], [[0, 0], [10, 500]], [[-1e5, 3], [1e5, -7]]]) {
      const fv = fitView(pts, size, o0);
      for (const [e, n] of pts) {
        const p = toScreen(fv, size, e, n);
        assert.equal(p.visible, true, `${JSON.stringify(size)} ${e},${n} → ${p.x},${p.y}`);
        assert.ok(p.x <= size.width - 1 + PX_EPS && p.y <= size.height - 1 + PX_EPS);
        assert.ok(p.x >= -PX_EPS && p.y >= -PX_EPS);
      }
    }
  }
});

test('view: 작은 크기에서 점이 보이고 축척이 크기에 단조(여백이 지도를 1px 로 붕괴시키지 않음)', () => {
  const pts = [[0, 0], [300, 200]];
  let prev = Infinity;
  for (const [w, h] of [[20, 20], [33, 600], [34, 600], [100, 600], [800, 600]]) {
    const size = { width: w, height: h };
    const fv = fitView(pts, size, OPTS);
    for (const [e, n] of pts) assert.equal(toScreen(fv, size, e, n).visible, true, `${w}x${h}`);
    // 크기가 커질수록 metersPerPx 는 작아진다(같거나 작음 아님: 이 목록에서는 엄격히 감소).
    assert.ok(fv.metersPerPx < prev, `${w}x${h}: ${fv.metersPerPx} < ${prev}`);
    prev = fv.metersPerPx;
  }
  // 20×20 은 지도가 1px 가 아니다: avail > 1.
  assert.ok(fitView(pts, { width: 20, height: 20 }, OPTS).metersPerPx < 300);
  // 촘촘한 크기 훑기: min(w,h) 가 1 늘 때마다 metersPerPx 가 늘지 않는다.
  let last = Infinity;
  for (let s = 2; s <= 120; s++) {
    const mpp = fitView(pts, { width: s, height: 600 }, OPTS).metersPerPx;
    assert.ok(mpp <= last, `s=${s}`);
    last = mpp;
  }
});

test('view: 하한 미만 span 은 metersPerPx 하한으로 고정(던지지 않음)', () => {
  const size = { width: 800, height: 600 };
  for (const minSpanM of [5e-324, 1e-9]) {
    const v = fitView([[0, 0]], size, { minSpanM, marginPx: 16 });
    assert.equal(v.metersPerPx, TOWER_FALLBACK_LIMITS.minMetersPerPx);
  }
  const ok = fitView([[0, 0]], size, { minSpanM: TOWER_FALLBACK_LIMITS.minMetersPerPx * 568, marginPx: 16 });
  assert.ok(Number.isFinite(ok.metersPerPx) && ok.metersPerPx > 0);
});

test('view: 5e-324 의 minSpanM·setView 는 RangeError 이고 frame 좌표는 유한', () => {
  assert.throws(() => createTowerFallback({ minSpanM: 5e-324 }), RangeError);
  const f = createTowerFallback();
  f.setAvailable(false);
  f.setDrones([{ id: 'a', enu: [1e6, -1e6, 0] }, { id: 'b', enu: [-1e6, 1e6, 0] }]);
  assert.throws(() => f.setView({ centerE: 0, centerN: 0, metersPerPx: 5e-324 }), RangeError);
  const fr = f.frame({ width: 800, height: 600 });
  for (const d of fr.drones) assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y));
  // 하한 값 그대로여도 유한.
  f.setView({ centerE: 1e6, centerN: -1e6, metersPerPx: TOWER_FALLBACK_LIMITS.minMetersPerPx });
  for (const d of f.frame({ width: 800, height: 600 }).drones) assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y));
});

test('markers: yaw 는 ENU 방위(0=북, 시계 +)로 그대로 전달되고 π/2 는 화면 오른쪽(동)이다', () => {
  const view = { centerE: 0, centerN: 0, metersPerPx: 1 };
  const size = { width: 200, height: 200 };
  const yaw = Math.PI / 2;
  const [m] = buildMarkers(view, size, [{ id: 'a', enu: [0, 0, 0], yaw }], false);
  assert.equal(m.yaw, yaw); // 보정 없이 그대로
  // 방위 yaw 로 앞(sin yaw, cos yaw)에 놓인 점은 화면에서 (sin yaw, −cos yaw) 쪽에 놓인다: π/2 → +x, y 불변.
  const [h] = buildMarkers(view, size, [{ id: 'h', enu: [10 * Math.sin(yaw), 10 * Math.cos(yaw), 0] }], false);
  assert.ok(Math.abs(h.x - (m.x + 10)) < 1e-9 && Math.abs(h.y - m.y) < 1e-9);
  // yaw=0 은 북 → 화면 위(y 감소).
  const [n0] = buildMarkers(view, size, [{ id: 'n', enu: [0, 10, 0] }], false);
  assert.ok(n0.y === m.y - 10 && n0.x === m.x);
});
