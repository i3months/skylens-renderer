// 추적 카메라 입력 검사의 견고성 시험(F-427·F-428). 통과한 입력으로는 camera()·step() 이 던지지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChaseCamera } from './index.mjs';
import { createChaseState } from './state.mjs';
import { wrapPi, dampScalar } from './damp.mjs';

const F32_MAX = 3.4028234663852886e38;

test('index: float32 를 넘는 pos·옵션은 그 자리에서 RangeError', () => {
  assert.throws(() => createChaseCamera().setTarget([4e38, 0, 0], 0), RangeError);
  assert.throws(() => createChaseCamera().setTarget([0, -4e38, 0], 0), RangeError);
  assert.throws(() => createChaseCamera().setTarget([0, 0, 1.7e308], 0), RangeError);
  assert.throws(() => createChaseCamera({ distM: 1e39 }), RangeError);
  assert.throws(() => createChaseCamera({ heightM: 1e39 }), RangeError);
  assert.throws(() => createChaseCamera({ lookAheadM: -1e39 }), RangeError);
  // 각각은 float32 안이어도 합으로 카메라 위치가 넘치면 막는다.
  assert.throws(() => createChaseCamera({ distM: 2e38, heightM: 2e38 }), RangeError);
  assert.throws(() => createChaseCamera({ distM: 1e32, heightM: 10 }).setTarget([F32_MAX, 0, 0], 0), RangeError);
  const c = createChaseCamera({ distM: 0, heightM: 0 });
  assert.doesNotThrow(() => c.setTarget([F32_MAX, -F32_MAX, 0], 0));
  assert.doesNotThrow(() => c.camera());
});

test('index: 큰 목표를 거쳐도 camera()·step() 이 던지지 않는다', () => {
  const c = createChaseCamera({ distM: 0, heightM: 0 });
  c.setTarget([F32_MAX, 0, 0], 0);
  c.setTarget([-F32_MAX, 0, 0], 0);
  for (let i = 0; i < 10; i++) {
    assert.doesNotThrow(() => c.step(0.016));
    assert.ok(Number.isFinite(c.camera().pos[0]));
  }
});

test('damp: dampScalar 는 차이가 배정밀도를 넘쳐도 유한하다', () => {
  const r = dampScalar(1.7e308, -1.7e308, 0.5);
  assert.ok(Number.isFinite(r));
  assert.ok(Math.abs(r) <= 1.7e308);
  assert.equal(dampScalar(1.7e308, -1.7e308, 1), -1.7e308);
  assert.equal(dampScalar(1, 3, 0.5), 2);
});

test('index: 통과한 입력 무작위 퍼즈에서 camera()·step() 이 던지지 않는다(시드 고정)', () => {
  let seed = 20261005;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const mag = () => { // 0 ~ 1e39 를 로그 균등으로, 부호 무작위
    const m = 10 ** (rnd() * 41 - 2);
    return (rnd() < 0.5 ? -1 : 1) * m;
  };
  const opt = () => (rnd() < 0.3 ? undefined : Math.abs(mag()));
  let passed = 0, rejected = 0, runs = 0;
  for (let n = 0; n < 3000; n++) {
    const o = {};
    for (const k of ['distM', 'heightM', 'lookAheadM']) { const v = opt(); if (v !== undefined) o[k] = v; }
    let c;
    try { c = createChaseCamera(o); } catch (e) { assert.ok(e instanceof RangeError); rejected++; continue; }
    for (let j = 0; j < 4; j++) {
      const pos = [mag(), mag(), mag()];
      const yaw = (rnd() - 0.5) * 20 * (rnd() < 0.2 ? 1e12 : 1);
      try { c.setTarget(pos, yaw); } catch (e) { assert.ok(e instanceof RangeError); rejected++; continue; }
      passed++;
      assert.doesNotThrow(() => { c.step(rnd() * 0.3); c.camera(); }, JSON.stringify({ o, pos, yaw }));
      if (rnd() < 0.2) assert.doesNotThrow(() => { c.snap(); c.camera(); });
      runs++;
    }
  }
  assert.ok(passed >= 2000 && rejected >= 100, `통과 ${passed}, 거부 ${rejected}`);
  assert.ok(runs >= 2000);
});

test('damp: wrapPi 는 큰 |rad| 에서도 (−π, π] 안이다', () => {
  for (const x of [1e9, 5.7e16, 1e18, -1e18, 1e20, -1e20, 3e20, 1.7e308, -1.7e308]) {
    const r = wrapPi(x);
    assert.ok(r > -Math.PI && r <= Math.PI, `wrapPi(${x}) = ${r}`);
  }
  // 알려진 값: 1e18 mod 2π 를 고정밀 정수 산술로 구한 −1.45214614222845834(독립 계산)
  assert.ok(Math.abs(wrapPi(1e18) - -1.4521461422284583) < 1e-12);
});

test('state: setTarget 직후 방위는 (−π, π] 이고 입력 배열 변경은 목표에 영향이 없다', () => {
  const s = createChaseState({ tauSec: 0.35, maxDtSec: 0.25 });
  s.setTarget([0, 0, 0], 3 * Math.PI);
  assert.ok(Math.abs(s.state().yaw - Math.PI) < 1e-12);
  assert.ok(s.state().yaw > -Math.PI && s.state().yaw <= Math.PI);
  s.setTarget([0, 0, 0], 1e18);
  s.snap();
  const y = s.state().yaw;
  assert.ok(y > -Math.PI && y <= Math.PI, `yaw ${y}`);
  // 입력 배열을 나중에 바꿔도 목표는 그대로다.
  const p = [10, 20, 30];
  s.setTarget(p, 0);
  p[0] = 999;
  s.snap();
  assert.deepEqual(s.state().pos, [10, 20, 30]);
});

test('index: setTarget 뒤 입력 배열 변경은 목표에 영향이 없다', () => {
  const c = createChaseCamera({ tauSec: 0 });
  c.setTarget([0, 0, 0], 0);
  const p = [10, 20, 30];
  c.setTarget(p, 0);
  p[0] = 999;
  assert.equal(c.step(0.1).pos[0], 10);
});

test('index: clearTarget 은 목표를 해제하고 camera()·step() 은 null, 재등장 컷은 snap()', () => {
  const c = createChaseCamera({ tauSec: 1, maxDtSec: 1 });
  c.setTarget([0, 0, 0], 0);
  assert.notEqual(c.camera(), null);
  c.clearTarget();
  assert.equal(c.camera(), null);
  assert.equal(c.step(0.1), null);
  c.snap(); // 목표가 없으니 아무것도 안 한다
  assert.equal(c.camera(), null);
  // 재등장: 옛 자리에서 날아오지 않고 snap 으로 컷
  c.setTarget([500, 0, 0], 0);
  c.snap();
  assert.equal(c.step(0).pos[0], 500);
  assert.equal(c.camera().pos[0], 500);
  c.clearTarget(); c.clearTarget(); // 반복 호출도 안전
  assert.equal(c.camera(), null);
});

test('index: step 의 형식 위반은 TypeError, 범위 위반은 RangeError', () => {
  const c = createChaseCamera();
  c.setTarget([0, 0, 0], 0);
  assert.throws(() => c.step('1'), TypeError);
  assert.throws(() => c.step(null), TypeError);
  assert.throws(() => c.step(undefined), TypeError);
  assert.throws(() => c.step(-1), RangeError);
  assert.throws(() => c.step(NaN), RangeError);
});
