// 관제탑 폴백 지도 맞춤·화면 변환(view.mjs) 시험. 기준 수치는 손으로 계산해 시험 안에 박아 두었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitView, toScreen } from './view.mjs';
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

  // width < 2·marginPx 인 작은 크기: avail = 1, metersPerPx = span.
  const tiny = fitView([[0, 0], [200, 100]], { width: 20, height: 600 }, OPTS);
  assert.equal(tiny.metersPerPx, 200);

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
