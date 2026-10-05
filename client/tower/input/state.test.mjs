// 자세 상태(createPoseState) 시험: 방위별 앞 이동 수치, 고도 자름, 회전·상쇄·dt 검사·사본 분리.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoseState } from './state.mjs';
import { TOWER_INPUT_DEFAULTS } from '../../../contracts/controlview/input.mjs';

const none = { yawLeft: false, yawRight: false, forward: false, back: false, altUp: false, altDown: false };
const hold = (o) => ({ ...none, ...o });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('state: 방위 0 에서 앞으로 1 s 이동하면 y 가 speed 만큼 늘고 x 는 0', () => {
  const s = createPoseState({ pos: [0, 0, 50], yaw: 0, speedMps: 10, maxDtSec: 1 });
  s.step(1, hold({ forward: true }));
  const p = s.pose();
  near(p.pos[0], 0);
  near(p.pos[1], 10);
  near(p.pos[2], 50);
  near(p.yaw, 0);
});

test('state: 방위 +90° 에서 앞은 동(+x)', () => {
  const s = createPoseState({ pos: [0, 0, 50], yaw: Math.PI / 2, speedMps: 10, maxDtSec: 1 });
  s.step(1, hold({ forward: true }));
  const p = s.pose();
  near(p.pos[0], 10);
  near(p.pos[1], 0);
});

test('state: 고도는 [minAltM, maxAltM] 로 잘린다', () => {
  const s = createPoseState({ pos: [0, 0, 498], altRateMps: 5, minAltM: 1, maxAltM: 500, maxDtSec: 1 });
  s.step(1, hold({ altUp: true }));
  assert.equal(s.pose().pos[2], 500);
  const t = createPoseState({ pos: [0, 0, 3], altRateMps: 5, minAltM: 1, maxAltM: 500, maxDtSec: 1 });
  t.step(1, hold({ altDown: true }));
  assert.equal(t.pose().pos[2], 1);
});

test('뒤로는 앞의 반대 방향', () => {
  const s = createPoseState({ pos: [0, 0, 50], yaw: 0, maxDtSec: 1 });
  s.step(0.5, hold({ back: true }));
  near(s.pose().pos[1], -5);
});

test('방위 회전: 오른쪽 키는 +, 왼쪽 키는 −', () => {
  const s = createPoseState({ pos: [0, 0, 50], yawRateRad: 1, maxDtSec: 1 });
  s.step(0.2, hold({ yawRight: true }));
  near(s.pose().yaw, 0.2);
  s.step(0.5, hold({ yawLeft: true }));
  near(s.pose().yaw, -0.3);
});

test('반대 키 쌍이 둘 다 눌리면 상쇄', () => {
  const s = createPoseState({ pos: [0, 0, 50], maxDtSec: 1 });
  s.step(1, hold({ forward: true, back: true, yawLeft: true, yawRight: true, altUp: true, altDown: true }));
  const p = s.pose();
  assert.deepEqual(p.pos, [0, 0, 50]);
  assert.equal(p.yaw, 0);
});

test('dt 는 유한 0 이상이어야 하고 maxDtSec 로 상한', () => {
  const s = createPoseState({ pos: [0, 0, 50], speedMps: 10, maxDtSec: 0.25 });
  for (const bad of [-1, NaN, Infinity, -Infinity]) assert.throws(() => s.step(bad, none), RangeError);
  assert.throws(() => s.step('1', none), TypeError);
  s.step(100, hold({ forward: true }));
  near(s.pose().pos[1], 2.5);
  const before = s.pose();
  s.step(0, hold({ forward: true, yawRight: true, altUp: true }));
  assert.deepEqual(s.pose(), before);
});

test('opts 검사와 기본값', () => {
  assert.throws(() => createPoseState(null), TypeError);
  assert.throws(() => createPoseState({ speedMps: 'a' }), TypeError);
  assert.throws(() => createPoseState({ speedMps: NaN }), RangeError);
  assert.throws(() => createPoseState({ minAltM: 10, maxAltM: 5 }), RangeError);
  assert.throws(() => createPoseState({ maxDtSec: 0 }), RangeError);
  assert.throws(() => createPoseState({ pos: [0, 0] }), TypeError);
  assert.throws(() => createPoseState({ pos: [0, 0, 9999] }), RangeError);
  assert.throws(() => createPoseState({ yaw: Infinity }), RangeError);
  const p = createPoseState().pose();
  assert.equal(p.pitch, TOWER_INPUT_DEFAULTS.pitchRad);
  assert.equal(p.pos[2], TOWER_INPUT_DEFAULTS.minAltM);
});

test('pose() 는 복사본', () => {
  const s = createPoseState({ pos: [1, 2, 3] });
  const p = s.pose();
  p.pos[0] = 99;
  p.yaw = 9;
  assert.deepEqual(s.pose().pos, [1, 2, 3]);
  assert.equal(s.pose().yaw, 0);
});

test('state: step 은 갱신된 pose 를 돌려준다(계약 TOWER_INPUT_API.step)', () => {
  const s = createPoseState({ pos: [0, 0, 10], yaw: 0, speedMps: 10, maxDtSec: 1 });
  const p = s.step(1, { forward: true });
  assert.deepEqual(p.pos, [0, 10, 10]);
  assert.deepEqual(p, s.pose());
});

test('state: 이동과 회전 동시 입력은 스텝 중간 방위로 이동한 뒤 yaw 를 갱신한다', () => {
  const s = createPoseState({ pos: [0, 0, 50], yaw: 0, yawRateRad: 1, speedMps: 10, maxDtSec: 10 });
  const p = s.step(1, hold({ forward: true, yawRight: true }));
  near(p.pos[0], 10 * Math.sin(0.5));
  near(p.pos[1], 10 * Math.cos(0.5));
  near(p.pos[0], 4.794255386042030);
  near(p.pos[1], 8.775825618903728);
  near(p.yaw, 1);
});

test('state: 사분원(ArrowUp+ArrowRight, π/2 s) 끝점은 dt 1/60 과 0.25 에서 0.2 m 이하로 같다', () => {
  const run = (dt) => {
    const s = createPoseState({ pos: [0, 0, 50], yaw: 0, yawRateRad: 1, speedMps: 10, maxDtSec: 1 });
    let left = Math.PI / 2;
    while (left > 1e-12) {
      const d = Math.min(dt, left);
      s.step(d, hold({ forward: true, yawRight: true }));
      left -= d;
    }
    return s.pose();
  };
  const a = run(1 / 60);
  const b = run(0.25);
  assert.ok(Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]) <= 0.2, `차이 ${Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1])}`);
  // 이론 끝점은 반지름 10 m 원호의 (10, 10).
  near(a.pos[0], 10, 0.05);
  near(a.pos[1], 10, 0.05);
  near(b.pos[0], 10, 0.2);
  near(b.pos[1], 10, 0.2);
  near(a.yaw, Math.PI / 2);
  near(b.yaw, Math.PI / 2);
});

test('state: speedMps·altRateMps 등이 1e6 을 넘으면 RangeError 이고 1e6 은 통과', () => {
  for (const k of ['speedMps', 'altRateMps', 'yawRateRad', 'maxDtSec']) {
    assert.throws(() => createPoseState({ [k]: 1e308 }), RangeError, k);
    assert.throws(() => createPoseState({ [k]: 1e6 + 1 }), RangeError, k);
  }
  const s = createPoseState({ speedMps: 1e6, altRateMps: 1e6, yawRateRad: 1e6, maxDtSec: 1e6 });
  const p = s.step(1e6, hold({ forward: true, yawRight: true, altUp: true }));
  assert.ok(p.pos.every(Number.isFinite) && Number.isFinite(p.yaw));
});

test('state: fovYRad·pitchRad·pos float32 검사', () => {
  for (const bad of [0, -0.1, Math.PI, 4, 1e-50]) assert.throws(() => createPoseState({ fovYRad: bad }), RangeError, String(bad));
  assert.throws(() => createPoseState({ fovYRad: Math.PI - 1e-9 }), RangeError);
  createPoseState({ fovYRad: 1 });
  assert.throws(() => createPoseState({ pitchRad: Math.PI / 2 + 1e-6 }), RangeError);
  assert.throws(() => createPoseState({ pitchRad: -Math.PI / 2 - 1e-6 }), RangeError);
  createPoseState({ pitchRad: Math.PI / 2 });
  createPoseState({ pitchRad: -Math.PI / 2 });
  assert.throws(() => createPoseState({ pos: [1e39, 0, 5] }), RangeError);
  assert.throws(() => createPoseState({ pos: [0, -1e39, 5] }), RangeError);
  createPoseState({ pos: [3e38, 0, 5] });
});

test('index: 생성 때 극단 opts 를 거부하고 1e308 속도에서 camera() 가 던지지 않는다', async () => {
  const { createTowerInput } = await import('./index.mjs');
  assert.throws(() => createTowerInput({ fovYRad: 4 }), RangeError);
  assert.throws(() => createTowerInput({ fovYRad: Math.PI }), RangeError);
  assert.throws(() => createTowerInput({ pitchRad: 2 }), RangeError);
  assert.throws(() => createTowerInput({ pos: [1e39, 0, 5] }), RangeError);
  assert.throws(() => createTowerInput({ speedMps: 1e308 }), RangeError);
  assert.throws(() => createTowerInput({ altRateMps: 1e308 }), RangeError);
  const t = createTowerInput({ speedMps: 1e6, altRateMps: 1e6, maxDtSec: 1e6 });
  t.keyDown('ArrowUp');
  t.keyDown('KeyE');
  t.step(1e6);
  t.camera();
});
