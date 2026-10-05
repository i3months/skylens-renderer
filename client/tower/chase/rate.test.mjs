// 추적 카메라 감쇠율 시험(T15.5). 계약: contracts/controlview/chase.mjs. 공개 API 만 쓰고 기준값은 숫자로 박았다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChaseCamera } from './index.mjs';

const TAU = 0.35;
const PI = Math.PI;

/** 시험 쪽에서 따로 적은 (−π, π] 접기. */
function fold(r) {
  let x = r % (2 * PI);
  if (x <= -PI) x += 2 * PI;
  else if (x > PI) x -= 2 * PI;
  return x;
}

/** 원점에서 시작해 목표를 (100,50,20) yaw 1 로 옮긴 카메라. */
function moved() {
  const c = createChaseCamera({ tauSec: TAU });
  c.setTarget([0, 0, 0], 0);
  c.setTarget([100, 50, 20], 1);
  return c;
}

function run(c, dt, n) {
  let last = null;
  for (let i = 0; i < n; i += 1) last = c.step(dt);
  return last;
}

test('rate: 프레임 길이와 무관하게 1 s 뒤 카메라 위치가 같다', () => {
  const a = moved(); run(a, 1 / 60, 60);
  const b = moved(); run(b, 1 / 30, 30);
  const d = moved(); run(d, 0.25, 4);
  const pa = a.camera().pos;
  for (const other of [b, d]) {
    const po = other.camera().pos;
    for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(pa[i] - po[i]) <= 1e-9, `성분 ${i}: ${pa[i]} vs ${po[i]}`);
  }
  // 기준 수치: 목표까지 남은 거리는 e^(-1/0.35) 배(식에서 직접 계산한 값)
  const r = moved(); const st = run(r, 0.25, 4);
  const left = Math.hypot(100 - st.pos[0], 50 - st.pos[1], 20 - st.pos[2]);
  const want = Math.hypot(100, 50, 20) * Math.exp(-1 / TAU);
  assert.ok(Math.abs(left - want) <= 1e-9, `${left} vs ${want}`);
});

test('rate: 목표를 고정하고 10 s 뒤에는 snap 한 카메라와 1e-6 이내로 같다', () => {
  const a = moved(); run(a, 0.25, 40);
  const s = createChaseCamera({ tauSec: TAU });
  s.setTarget([100, 50, 20], 1);
  const ca = a.camera(); const cs = s.camera();
  for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(ca.pos[i] - cs.pos[i]) <= 1e-6);
  for (let i = 0; i < 4; i += 1) assert.ok(Math.abs(ca.quat[i] - cs.quat[i]) <= 1e-6);
  assert.equal(ca.fovY, cs.fovY);
});

test('rate: 1 time constant 뒤 거리 잔여는 e^-1 배', () => {
  const c = createChaseCamera({ tauSec: TAU, maxDtSec: TAU }); // dt=0.35 가 상한에 걸리지 않게 상한을 올린다
  c.setTarget([0, 0, 0], 0);
  c.setTarget([30, 40, 0], 0); // 거리 50
  const st = c.step(TAU);
  const left = Math.hypot(30 - st.pos[0], 40 - st.pos[1]);
  assert.ok(Math.abs(left - 50 * Math.exp(-1)) <= 1e-9, `${left}`);
});

test('rate: 방위 ±π 경계에서 최단 호로 단조 증가하고 0 쪽으로 돌지 않는다', () => {
  const c = createChaseCamera({ tauSec: TAU });
  c.setTarget([0, 0, 0], 3.0);
  c.setTarget([0, 0, 0], -3.0);
  let prev = 3.0;
  for (let i = 0; i < 40; i += 1) {
    const yaw = c.step(0.1).yaw;
    const delta = fold(yaw - prev); // 접힌 값 포함 한 걸음의 호
    assert.ok(delta > 0, `step ${i}: 증가해야 한다 ${delta}`);
    assert.ok(Math.abs(fold(yaw - 3.0)) <= 0.2832 + 1e-9, `step ${i}: 3.0 에서 너무 멀다`);
    assert.ok(Math.abs(fold(yaw)) > 2.7, `step ${i}: 0 근처로 돌았다 ${yaw}`);
    prev = yaw;
  }
  assert.ok(Math.abs(fold(prev - -3.0)) < 1e-4); // 4 s 뒤 남은 호 0.2832·e^-11.4 ≈ 3e-6
});

test('rate: 등속 이동 목표의 정상 상태 지연은 speed·tau = 3.5 m', () => {
  const c = createChaseCamera({ tauSec: TAU });
  const dt = 1e-4; const v = 10; // 이산 오차 v·dt/2 = 5e-4 m
  let x = 0;
  c.setTarget([x, 0, 0], 0);
  let st = null;
  for (let i = 0; i < 120000; i += 1) { // 12 s ≈ 34 tau
    x += v * dt;
    c.setTarget([x, 0, 0], 0);
    st = c.step(dt);
  }
  assert.ok(Math.abs((x - st.pos[0]) - 3.5) <= 1e-3, `지연 ${x - st.pos[0]}`);
});
