// 감쇠 수학(damp) 시험: 계수 기준 수치, 분할 합성, wrapPi 경계, 최단 호 감쇠, 입력 검사.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dampFactor, wrapPi, dampScalar, dampAngle } from './damp.mjs';
import { TOWER_CHASE_TEST_NAMES } from '../../../contracts/controlview/chase.mjs';

const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const PI = Math.PI;

test(TOWER_CHASE_TEST_NAMES[0], () => {
  // 1 − e⁻¹
  near(dampFactor(0.35, 0.35), 0.6321205588285577);
  assert.equal(dampFactor(1, 0), 1);
  assert.equal(dampFactor(0.016, 0), 1);
  assert.equal(dampFactor(0, 0.35), 0);
  // 분할 합성: 1 − (1−a(dt/2))² = a(dt)
  for (const [dt, tau] of [[0.35, 0.35], [0.016, 0.35], [0.2, 0.05]]) {
    const h = dampFactor(dt / 2, tau);
    near(1 - (1 - h) * (1 - h), dampFactor(dt, tau));
  }
  // 입력 검사
  assert.throws(() => dampFactor(-0.1, 0.35), RangeError);
  assert.throws(() => dampFactor(0.1, -0.35), RangeError);
  assert.throws(() => dampFactor(NaN, 0.35), RangeError);
  assert.throws(() => dampFactor(0.1, Infinity), RangeError);
  assert.throws(() => dampFactor('0.1', 0.35), TypeError);
  assert.throws(() => dampFactor(0.1, null), TypeError);
});

test(TOWER_CHASE_TEST_NAMES[1], () => {
  near(wrapPi(3 * PI / 2), -PI / 2);
  assert.equal(wrapPi(PI), PI);
  assert.equal(wrapPi(-PI), PI);
  near(wrapPi(0), 0);
  near(wrapPi(-3 * PI / 2), PI / 2);
  near(wrapPi(5 * PI), PI);
  assert.throws(() => wrapPi(NaN), RangeError);
  assert.throws(() => wrapPi(Infinity), RangeError);
  assert.throws(() => wrapPi('1'), TypeError);
});

test('damp: dampScalar 는 cur 에서 target 쪽으로 a 만큼 간다', () => {
  assert.equal(dampScalar(10, 20, 0.5), 15);
  assert.equal(dampScalar(10, 20, 0), 10);
  assert.equal(dampScalar(10, 20, 1), 20);
  assert.throws(() => dampScalar(NaN, 1, 0.5), RangeError);
  assert.throws(() => dampScalar(1, 2, '0.5'), TypeError);
});

test('damp: dampAngle 은 최단 호로 돈다', () => {
  // 3.0 → −3.0 은 단순 보간이면 0(먼 쪽 3 rad), 최단 호면 +π 쪽(0.2832 rad 만큼, 절반이면 3.1416).
  const r = dampAngle(3.0, -3.0, 0.5);
  near(r, PI);
  assert.ok(Math.abs(r - 3.0) < 0.15, `${r} 는 3.0 근처여야 한다`);
  assert.ok(Math.abs(r) > 3, `${r} 는 0 쪽으로 돌면 안 된다`);
  // 반대 방향
  near(dampAngle(-3.0, 3.0, 0.5), -PI);
  // 경계 없는 경우는 단순 보간과 같다
  near(dampAngle(0.2, 0.6, 0.5), 0.4);
  assert.equal(dampAngle(1, 2, 0), 1);
  assert.throws(() => dampAngle(0, Infinity, 0.5), RangeError);
});
