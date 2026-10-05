import test from 'node:test';
import assert from 'node:assert/strict';
import { poseToView } from './view.mjs';
import { syncCamera } from '../../status/camera/index.mjs';
import { poseToCameraPose } from '../input/camera.mjs';

const SIZE = { width: 800, height: 600, devicePixelRatio: 1 };
const FOV = Math.PI / 2; // tan(45°)=1 → fy = 300
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

/** 투영(시험용 최소 구현: X_c = R·X + t, u = fx·x/d + cx). */
function project(view, p) {
  const { R, t, K } = view;
  const c = [0, 1, 2].map((i) => R[i * 3] * p[0] + R[i * 3 + 1] * p[1] + R[i * 3 + 2] * p[2] + t[i]);
  return { u: K.fx * c[0] / c[2] + K.cx, v: K.fy * c[1] / c[2] + K.cy, depth: c[2] };
}

const north = () => poseToCameraPose({ pos: [0, 0, 0], yaw: 0, pitch: 0 }, FOV);

test('view: poseToView 는 syncCamera 의 view 와 같다', () => {
  const pose = poseToCameraPose({ pos: [12.5, -3, 40], yaw: 0.7, pitch: -0.3 }, 0.9);
  const size = { width: 1280, height: 720, devicePixelRatio: 2 };
  assert.deepEqual(poseToView(pose, size), syncCamera(pose, size, 0).view);
});

test('view: 북쪽을 보는 카메라에서 북쪽 10 m 점은 화면 중앙·깊이 10', () => {
  const p = project(poseToView(north(), SIZE), [0, 10, 0]);
  near(p.u, 400);
  near(p.v, 300);
  near(p.depth, 10);
});

test('view: 동쪽 점은 오른쪽, 위쪽 점은 화면 위쪽(v 작음)', () => {
  const view = poseToView(north(), SIZE);
  const e = project(view, [10, 10, 0]); // x_c = 10, d = 10 → u = 300·1 + 400
  near(e.u, 700);
  near(e.v, 300);
  const up = project(view, [0, 10, 10]);
  near(up.u, 400);
  near(up.v, 0);
});

test('view: 내부 파라미터는 fovY·크기에서 나온다', () => {
  const view = poseToView(north(), SIZE);
  near(view.K.fy, 300);
  near(view.K.fx, 300);
  assert.equal(view.K.cx, 400);
  assert.equal(view.K.cy, 300);
  assert.equal(view.width, 800);
  assert.equal(view.height, 600);
});

test('view: 위치 이동은 t = −R·pos 로 반영된다', () => {
  const view = poseToView(poseToCameraPose({ pos: [5, 20, 0], yaw: 0, pitch: 0 }, FOV), SIZE);
  const p = project(view, [5, 30, 0]);
  near(p.u, 400);
  near(p.v, 300);
  near(p.depth, 10);
});

test('view: 카메라 뒤 점은 깊이가 음수', () => {
  assert.ok(project(poseToView(north(), SIZE), [0, -10, 0]).depth < 0);
});

test('view: 입력 검사 위반은 TypeError·RangeError', () => {
  const ok = north();
  assert.throws(() => poseToView(null, SIZE), TypeError);
  assert.throws(() => poseToView({ ...ok, pos: [0, 0] }, SIZE), TypeError);
  assert.throws(() => poseToView({ ...ok, fovY: '1' }, SIZE), TypeError);
  assert.throws(() => poseToView({ ...ok, pos: [NaN, 0, 0] }, SIZE), RangeError);
  assert.throws(() => poseToView({ ...ok, quat: [0, 0, 0, 0] }, SIZE), RangeError);
  assert.throws(() => poseToView({ ...ok, fovY: Math.PI }, SIZE), RangeError);
  assert.throws(() => poseToView(ok, { width: 0, height: 600, devicePixelRatio: 1 }), RangeError);
});

test('view: 입력 pose·size 는 바뀌지 않는다', () => {
  const pose = poseToCameraPose({ pos: [1, 2, 3], yaw: 1, pitch: 0.2 }, 1);
  const size = { ...SIZE };
  const before = JSON.stringify([pose, size]);
  const view = poseToView(pose, size);
  assert.equal(JSON.stringify([pose, size]), before);
  view.R[0] = 99; // 결과를 고쳐도 입력 불변
  assert.equal(JSON.stringify([pose, size]), before);
});
