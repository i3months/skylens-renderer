// state.mjs 시험. 이름은 contracts/controlview/chase.mjs TOWER_CHASE_TEST_NAMES 를 따른다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChaseState } from './state.mjs';

const TAU = 0.35;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

// (0,0,0) 에 놓고 목표를 (10,0,0) 으로 옮긴 상태
function started(cfg = { tauSec: TAU, maxDtSec: 0.25 }) {
  const s = createChaseState(cfg);
  s.setTarget([0, 0, 0], 0);
  s.snap();
  s.setTarget([10, 0, 0], 0);
  return s;
}

test('state: 첫 setTarget 은 감쇠 없이 놓는다', () => {
  const s = createChaseState({ tauSec: TAU, maxDtSec: 0.25 });
  assert.equal(s.state(), null);
  assert.equal(s.step(0.1), null);
  s.setTarget([100, -50, 20], 1.5);
  assert.deepEqual(s.state(), { pos: [100, -50, 20], yaw: 1.5 });
  // 이후 호출은 목표만 바꾼다
  s.setTarget([0, 0, 0], 0);
  assert.deepEqual(s.state(), { pos: [100, -50, 20], yaw: 1.5 });
  // snap 은 목표로 즉시
  s.snap();
  assert.deepEqual(s.state(), { pos: [0, 0, 0], yaw: 0 });
  // 복사본
  const c = s.state(); c.pos[0] = 99;
  assert.equal(s.state().pos[0], 0);
  const r = s.step(0.1); r.pos[0] = 99;
  assert.equal(s.state().pos[0], 0);
});

test('state: 한 번 step(dt) 은 차이를 (1 − exp(−dt/tau)) 만큼 줄인다', () => {
  const s = started({ tauSec: TAU, maxDtSec: 1 }); // 상한이 걸리지 않게 1
  const r = s.step(TAU);
  const a = 1 - Math.exp(-1);
  near(a, 0.6321205588, 1e-10);
  near(r.pos[0], 10 * 0.6321205588, 1e-8, 'x');
  near(10 - r.pos[0], 10 * (1 - 0.6321205588), 1e-8, 'rest');
  assert.equal(r.pos[1], 0);
  // dt=0 이면 변화 없음
  assert.deepEqual(s.step(0), r);
  // tau=0 이면 한 스텝에 목표
  const z = started({ tauSec: 0, maxDtSec: 0.25 });
  assert.deepEqual(z.step(0.01).pos, [10, 0, 0]);
});

test('state: dt 를 둘로 나눠 두 번 걸어도 한 번과 같다', () => {
  const a = started(); a.step(0.1); const ra = a.step(0.1);
  const b = started(); const rb = b.step(0.2);
  for (let i = 0; i < 3; i++) near(ra.pos[i], rb.pos[i], 1e-12, `pos${i}`);
  // 방위도 같다
  const mk = () => { const s = createChaseState({ tauSec: TAU, maxDtSec: 0.25 }); s.setTarget([0, 0, 0], 1); s.setTarget([0, 0, 0], -2); return s; };
  const c = mk(); c.step(0.1); const rc = c.step(0.1);
  const d = mk(); const rd = d.step(0.2);
  near(rc.yaw, rd.yaw, 1e-12, 'yaw');
  // dt 상한: 10 은 maxDtSec 0.25 와 같다
  const e = started(); const re = e.step(10);
  const f = started(); const rf = f.step(0.25);
  assert.deepEqual(re, rf);
  near(re.pos[0], 10 * (1 - Math.exp(-0.25 / TAU)), 1e-12);
});

test('state: 방위 ±π 경계를 가로질러도 최단 호로 돈다', () => {
  const s = createChaseState({ tauSec: TAU, maxDtSec: 1 });
  s.setTarget([0, 0, 0], 3.0);
  s.setTarget([0, 0, 0], -3.0);
  const arc = 2 * Math.PI - 6; // 0.2832
  near(arc, 0.2832, 1e-4);
  const a = 1 - Math.exp(-1);
  const r = s.step(TAU);
  // yaw 가 증가해 π 를 넘고 (−π, π] 로 접힌다
  const unwrapped = 3.0 + arc * a;
  assert.ok(unwrapped > Math.PI);
  near(r.yaw, unwrapped - 2 * Math.PI, 1e-12, 'folded');
  assert.ok(r.yaw > -Math.PI && r.yaw <= Math.PI);
  // 남은 최단 호는 arc·(1−a)
  let rest = -3.0 - r.yaw; rest = rest > Math.PI ? rest - 2 * Math.PI : rest < -Math.PI ? rest + 2 * Math.PI : rest;
  near(Math.abs(rest), arc * (1 - a), 1e-12, 'rest arc');
  // 먼 쪽(−6)으로 돌지 않는다: 한 번 더 걸어도 yaw 는 −3 에 접근하며 증가
  const r2 = s.step(TAU);
  assert.ok(r2.yaw > r.yaw);
});

test('state: 입력 검사', () => {
  const s = createChaseState({ tauSec: TAU, maxDtSec: 0.25 });
  assert.throws(() => s.setTarget('x', 0), TypeError);
  assert.throws(() => s.setTarget([1, 2], 0), RangeError);
  assert.throws(() => s.setTarget([1, 2, NaN], 0), RangeError);
  assert.throws(() => s.setTarget([1, 2, '3'], 0), TypeError);
  assert.throws(() => s.setTarget([1, 2, 3], Infinity), RangeError);
  assert.throws(() => s.setTarget([1, 2, 3], '0'), TypeError);
  assert.equal(s.state(), null);
  s.setTarget([0, 0, 0], 0);
  assert.throws(() => s.step(-1), RangeError);
  assert.throws(() => s.step(NaN), RangeError);
  assert.throws(() => s.step('1'), TypeError);
  assert.throws(() => createChaseState({ tauSec: -1 }), RangeError);
  assert.throws(() => createChaseState({ maxDtSec: 0 }), RangeError);
});
