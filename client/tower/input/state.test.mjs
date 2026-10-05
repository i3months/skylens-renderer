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
