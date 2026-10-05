// rig.mjs 시험(T15.5). 기준값은 손으로 계산한 숫자다(구현식을 되풀이하지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rigPose } from './rig.mjs';
import { poseToCameraPose } from '../input/camera.mjs';

const EPS = 1e-9;
const near = (a, b, msg) => {
  assert.equal(a.length, b.length, msg);
  for (let i = 0; i < a.length; i += 1) assert.ok(Math.abs(a[i] - b[i]) <= EPS, `${msg} [${i}] ${a[i]} != ${b[i]}`);
};
const cfg = { distM: 30, heightM: 10, lookAheadM: 0 };
const P0 = { pos: [0, 0, 0], yaw: 0 };

// 쿼터니언(x,y,z,w) 으로 카메라 앞(+z 축)을 ENU 로 돌린 벡터.
const forward = ([x, y, z, w]) => [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];

test('rig: 방위 0 이면 카메라는 목표 남쪽 distM 뒤·heightM 위에 있고 시선은 목표를 향한다', () => {
  const r = rigPose(P0, cfg);
  near(r.pos, [0, -30, 10], '위치');
  assert.ok(Math.abs(r.yaw - 0) <= EPS);
  assert.ok(Math.abs(r.pitch - -0.3217505544) <= 1e-9, `pitch ${r.pitch}`);
  // yaw π/2: 카메라는 서쪽, 동쪽(+x)을 본다.
  const e = rigPose({ pos: [0, 0, 0], yaw: Math.PI / 2 }, cfg);
  near(e.pos, [-30, 0, 10], '위치 π/2');
  assert.ok(Math.abs(e.yaw - Math.PI / 2) <= EPS);
  assert.ok(Math.abs(e.pitch - -0.3217505544) <= 1e-9);
});

test('rig: lookAhead 는 시선 지점을 앞으로 옮긴다', () => {
  // 위치 (0,−30,10), 시선 (0,5,0): d=(0,35,−10).
  const r = rigPose(P0, { ...cfg, lookAheadM: 5 });
  near(r.pos, [0, -30, 10], '위치');
  assert.ok(Math.abs(r.yaw) <= EPS);
  assert.ok(Math.abs(r.pitch - -0.27829965900511133) <= EPS, `pitch ${r.pitch}`);
  // 목표가 (100,200,50) 이고 yaw π/2: 위치 (70,200,60), 시선 (105,200,50): d=(35,0,−10).
  const e = rigPose({ pos: [100, 200, 50], yaw: Math.PI / 2 }, { ...cfg, lookAheadM: 5 });
  near(e.pos, [70, 200, 60], '위치 이동');
  assert.ok(Math.abs(e.yaw - Math.PI / 2) <= EPS);
  assert.ok(Math.abs(e.pitch - -0.27829965900511133) <= EPS);
});

test('rig: 퇴화는 yaw=state.yaw, pitch=0', () => {
  const z = rigPose({ pos: [1, 2, 3], yaw: 0.7 }, { distM: 0, heightM: 0, lookAheadM: 0 });
  near(z.pos, [1, 2, 3], '위치');
  assert.equal(z.yaw, 0.7);
  assert.equal(z.pitch, 0);
  // 바로 아래를 봄: 수평 0, 높이 10
  const dn = rigPose({ pos: [0, 0, 0], yaw: 0.7 }, { distM: 0, heightM: 10, lookAheadM: 0 });
  assert.equal(dn.yaw, 0.7);
  assert.ok(Math.abs(dn.pitch + Math.PI / 2) <= EPS);
});

test('rig: 결과를 poseToCameraPose 에 넣으면 카메라 앞이 (시선 − 위치) 방향이다', () => {
  const cases = [
    [P0, cfg], [{ pos: [0, 0, 0], yaw: Math.PI / 2 }, { ...cfg, lookAheadM: 5 }],
    [{ pos: [100, -50, 20], yaw: 2.3 }, { distM: 12, heightM: 4, lookAheadM: 8 }],
    [{ pos: [3, 4, 5], yaw: -2.9 }, { distM: 40, heightM: 0, lookAheadM: 15 }],
  ];
  for (const [st, cf] of cases) {
    const pose = rigPose(st, cf);
    const cam = poseToCameraPose(pose, 0.9);
    const s = Math.sin(st.yaw), c = Math.cos(st.yaw);
    const eye = [st.pos[0] - cf.distM * s, st.pos[1] - cf.distM * c, st.pos[2] + cf.heightM];
    const look = [st.pos[0] + cf.lookAheadM * s, st.pos[1] + cf.lookAheadM * c, st.pos[2]];
    const d = look.map((v, i) => v - eye[i]);
    const n = Math.hypot(...d);
    near(cam.pos, eye, '카메라 위치');
    near(forward(cam.quat), d.map((v) => v / n), `앞 ${JSON.stringify(st)}`);
  }
});

test('rig: 입력 검사', () => {
  assert.throws(() => rigPose(null, cfg), TypeError);
  assert.throws(() => rigPose(P0, null), TypeError);
  assert.throws(() => rigPose({ pos: [0, 0], yaw: 0 }, cfg), TypeError);
  assert.throws(() => rigPose({ pos: [0, 0, '0'], yaw: 0 }, cfg), TypeError);
  assert.throws(() => rigPose({ pos: [0, 0, 0], yaw: '0' }, cfg), TypeError);
  assert.throws(() => rigPose(P0, { ...cfg, distM: '30' }), TypeError);
  assert.throws(() => rigPose({ pos: [0, NaN, 0], yaw: 0 }, cfg), RangeError);
  assert.throws(() => rigPose({ pos: [0, 0, 0], yaw: Infinity }, cfg), RangeError);
  assert.throws(() => rigPose(P0, { ...cfg, heightM: NaN }), RangeError);
  assert.throws(() => rigPose(P0, { ...cfg, lookAheadM: -Infinity }), RangeError);
  const st = { pos: [1, 2, 3], yaw: 0.5 };
  rigPose(st, cfg);
  assert.deepEqual(st, { pos: [1, 2, 3], yaw: 0.5 });
});
