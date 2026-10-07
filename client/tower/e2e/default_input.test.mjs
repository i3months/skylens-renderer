// 기본값 경로 손계산: createControlView 가 input 옵션 없이 입력 층 기본값(8 m/s·0.95 rad/s)을 쓰는지 본다.
// 좌표: ENU(x=동, y=북, z=위), yaw 0 = 북(+y), 시계 방향이 +. 카메라 축: 오른쪽 x, 아래 y, 앞 z(카메라→ENU 쿼터니언).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlView } from './index.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const SIZE = { width: 320, height: 240 };
const PITCH = -0.3; // 기본 피치

// 쿼터니언 [x,y,z,w] 가 돌린 카메라 앞축(0,0,1) 의 ENU 성분.
const forwardOf = ([x, y, z, w]) => [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];

test('e2e 기본값: ArrowUp dt 0.1 → y +0.8 (speed 8)', () => {
  const view = createControlView({ input: { pos: [0, 0, 10], yaw: 0 } });
  view.keyDown('ArrowUp');
  view.step(0.1, SIZE);
  const { camera } = view.snapshot(SIZE);
  near(camera.pos[0], 0);
  near(camera.pos[1], 0.8);
});

test('e2e 기본값: ArrowRight dt 0.2 → yaw 0.19 (선회 0.95)', () => {
  const view = createControlView({ input: { pos: [0, 0, 10], yaw: 0 } });
  view.keyDown('ArrowRight');
  view.step(0.2, SIZE);
  const f = forwardOf(view.snapshot(SIZE).camera.quat);
  // 앞축 = (sin yaw·cos pitch, cos yaw·cos pitch, sin pitch).
  near(f[0], Math.sin(0.19) * Math.cos(PITCH), 1e-6);
  near(f[1], Math.cos(0.19) * Math.cos(PITCH), 1e-6);
  near(f[2], Math.sin(PITCH), 1e-6);
});
