// 관제탑 입력 층 카메라 변환(camera.mjs) 시험. 기준 수치는 시험 안에 박아 두었다.
// 참조 구현은 client/status/camera syncCamera(contracts/statusview: view.R = 카메라→ENU 회전의 전치, t = −R·pos).
import test from 'node:test';
import assert from 'node:assert/strict';
import { poseToCameraPose, canonicalQuat } from './camera.mjs';
import { syncCamera } from '../../status/camera/index.mjs';
import { TOWER_INPUT_TEST_NAMES, TOWER_INPUT_MODULES, TOWER_INPUT_DEFAULTS } from '../../../contracts/controlview/input.mjs';

const NAME_AXES = 'camera: yaw=0 pitch=0 이면 카메라 앞(z)이 북이고 오른쪽(x)이 동';
const NAME_RASTER = 'camera: quat 는 단위이고 카메라→ENU 회전이 contracts/raster 의 R 과 맞는다';
const EPS = 1e-12;
const FOV = TOWER_INPUT_DEFAULTS.fovYRad;

/** 시험 쪽에서 따로 적은 단위 쿼터니언(x,y,z,w) → 행 우선 3×3(열 j = 카메라 j 번째 축의 ENU 방향). */
function rotFromQuat([x, y, z, w]) {
  return [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ];
}
const col = (M, j) => [M[0][j], M[1][j], M[2][j]];

function near(actual, expected, eps, msg) {
  assert.equal(actual.length, expected.length, msg);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= eps, `${msg ?? ''}[${i}]: ${actual[i]} vs ${expected[i]}`);
  }
}

test('계약 시험 이름과 모듈 파일이 맞다', () => {
  assert.ok(TOWER_INPUT_TEST_NAMES.includes(NAME_AXES));
  assert.ok(TOWER_INPUT_TEST_NAMES.includes(NAME_RASTER));
  assert.equal(TOWER_INPUT_MODULES.camera.file, 'camera.mjs');
});

test(NAME_AXES, () => {
  const cam = poseToCameraPose({ pos: [1, 2, 3], yaw: 0, pitch: 0 }, FOV);
  // (a) 카메라→ENU 회전의 열 배치: 열0(오른쪽 x)=[1,0,0], 열1(아래 y)=[0,0,-1], 열2(앞 z)=[0,1,0].
  //     즉 열 목록 [[1,0,0],[0,0,-1],[0,1,0]], 행 우선으로는 [[1,0,0],[0,0,1],[0,-1,0]].
  const M = rotFromQuat(cam.quat);
  near(col(M, 0), [1, 0, 0], EPS, '오른쪽=동');
  near(col(M, 1), [0, 0, -1], EPS, '아래=ENU −z');
  near(col(M, 2), [0, 1, 0], EPS, '앞=북');
  near(M.flat(), [1, 0, 0, 0, 0, 1, 0, -1, 0], EPS, '행 우선');
  // 쿼터니언 값: Rx(−π/2) = (−√½, 0, 0, √½).
  near(cam.quat, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], EPS, 'quat');
  assert.deepEqual(cam.pos, [1, 2, 3]);
  assert.equal(cam.fovY, FOV);

  // (b) yaw = +π/2(시계 방향 90°) 이면 앞 = 동(+x), 오른쪽 = 남(−y), 아래는 그대로 −z.
  const east = rotFromQuat(poseToCameraPose({ pos: [0, 0, 0], yaw: Math.PI / 2, pitch: 0 }, FOV).quat);
  near(col(east, 2), [1, 0, 0], EPS, 'yaw=π/2 앞');
  near(col(east, 0), [0, -1, 0], EPS, 'yaw=π/2 오른쪽');
  near(col(east, 1), [0, 0, -1], EPS, 'yaw=π/2 아래');

  // (c) pitch = −0.3(기본값, 아래를 봄) 이면 앞 = (0, cos 0.3, sin(−0.3)).
  assert.equal(TOWER_INPUT_DEFAULTS.pitchRad, -0.3);
  const down = rotFromQuat(poseToCameraPose({ pos: [0, 0, 0], yaw: 0, pitch: -0.3 }, FOV).quat);
  const f = col(down, 2);
  assert.ok(Math.abs(f[2] - Math.sin(-0.3)) <= EPS, `앞 z = ${f[2]} 기대 ${Math.sin(-0.3)} (= -0.29552020666133955)`);
  assert.ok(Math.abs(f[2] - -0.29552020666133955) <= EPS);
  near(f, [0, Math.cos(0.3), Math.sin(-0.3)], EPS, 'pitch=−0.3 앞');
  near(col(down, 0), [1, 0, 0], EPS, 'pitch 는 오른쪽 축을 바꾸지 않는다');

  // 일반 자세: 앞 = (sin yaw·cos pitch, cos yaw·cos pitch, sin pitch), 오른쪽 = (cos yaw, −sin yaw, 0).
  for (const [yaw, pitch] of [[0.7, 0.2], [-2.1, -0.3], [3.0, 1.2], [-0.4, -1.1]]) {
    const G = rotFromQuat(poseToCameraPose({ pos: [0, 0, 0], yaw, pitch }, FOV).quat);
    near(col(G, 2), [Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)], EPS, `앞 ${yaw},${pitch}`);
    near(col(G, 0), [Math.cos(yaw), -Math.sin(yaw), 0], EPS, `오른쪽 ${yaw},${pitch}`);
  }
});

test(NAME_RASTER, () => {
  const cases = [
    { pos: [0, 0, 0], yaw: 0, pitch: 0 },
    { pos: [12.5, -40, 30], yaw: Math.PI / 2, pitch: 0 },
    { pos: [-3, 7, 15], yaw: 0, pitch: -0.3 },
    { pos: [100, 200, 50], yaw: 0.7, pitch: -0.3 },
    { pos: [-250, 80, 5], yaw: -2.4, pitch: 0.45 },
    { pos: [0, 0, 1], yaw: Math.PI, pitch: 0 },
    { pos: [0, 0, 1], yaw: 9.5, pitch: -1.2 },
  ];
  const size = { width: 640, height: 480, devicePixelRatio: 1 };
  for (const p of cases) {
    const cam = poseToCameraPose(p, FOV);
    // 단위 길이와 부호 규약 w ≥ 0.
    assert.ok(Math.abs(Math.hypot(...cam.quat) - 1) <= EPS, `|q| = ${Math.hypot(...cam.quat)}`);
    assert.ok(cam.quat[3] >= 0, `w = ${cam.quat[3]}`);
    // (d) 쿼터니언 → 행렬을 시험 쪽에서 직접 계산한 R(세계→카메라 = 전치)이 syncCamera view.R 과 1e-9 안에서 같다.
    const M = rotFromQuat(cam.quat);
    const Rmine = [0, 1, 2].flatMap((i) => [M[0][i], M[1][i], M[2][i]]);
    const { view } = syncCamera(cam, size, 0);
    near(view.R, Rmine, 1e-9, `view.R ${JSON.stringify(p)}`);
    // contracts/raster: X_c = R·X_w + t. 카메라 위치는 X_c = 0, 앞 1 m 점은 X_c = (0,0,1).
    const proj = (X) => [0, 1, 2].map((i) => view.R[i * 3] * X[0] + view.R[i * 3 + 1] * X[1] + view.R[i * 3 + 2] * X[2] + view.t[i]);
    near(proj(p.pos), [0, 0, 0], 1e-9, '카메라 원점');
    const fw = [Math.sin(p.yaw) * Math.cos(p.pitch), Math.cos(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch)];
    near(proj([p.pos[0] + fw[0], p.pos[1] + fw[1], p.pos[2] + fw[2]]), [0, 0, 1], 1e-9, '앞 1 m');
    // 정확한 회전: R·Rᵀ = I, det = +1.
    const R = view.R;
    const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    assert.ok(Math.abs(det - 1) <= 1e-12, `det = ${det}`);
  }
  // 기준 자세 view.R 수치: 행 = 카메라 축의 ENU 방향 → [[1,0,0],[0,0,-1],[0,1,0]].
  const { view } = syncCamera(poseToCameraPose({ pos: [0, 0, 0], yaw: 0, pitch: 0 }, FOV), size, 0);
  near(view.R, [1, 0, 0, 0, 0, -1, 0, 1, 0], 1e-12, '기준 view.R');
});

test('camera: 쿼터니언 부호 규약(w ≥ 0, w = 0 이면 첫 0 아닌 성분 > 0)', () => {
  assert.deepEqual(canonicalQuat([0.5, -0.5, 0.5, -0.5]), [-0.5, 0.5, -0.5, 0.5]);
  assert.deepEqual(canonicalQuat([0, -1, 0, 0]), [0, 1, 0, 0]);
  assert.deepEqual(canonicalQuat([-0, 0, 0, 1]), [0, 0, 0, 1]);
  assert.ok(Object.is(canonicalQuat([-0, 0, 0, 1])[0], 0));
  // yaw = π 근처(w 가 음으로 넘어가는 구간)에서도 w ≥ 0 이고 회전은 같다.
  for (const yaw of [Math.PI, -Math.PI, 3 * Math.PI, 2 * Math.PI + 0.1]) {
    const q = poseToCameraPose({ pos: [0, 0, 0], yaw, pitch: 0.1 }, FOV).quat;
    assert.ok(q[3] >= 0, `yaw ${yaw}: w = ${q[3]}`);
    near(col(rotFromQuat(q), 2), [Math.sin(yaw) * Math.cos(0.1), Math.cos(yaw) * Math.cos(0.1), Math.sin(0.1)], 1e-12, `yaw ${yaw}`);
  }
});

test('camera: 입력 검사 위반은 TypeError/RangeError 이고 입력을 바꾸지 않는다', () => {
  const ok = { pos: [1, 2, 3], yaw: 0.2, pitch: -0.3 };
  assert.throws(() => poseToCameraPose(null, FOV), TypeError);
  assert.throws(() => poseToCameraPose(7, FOV), TypeError);
  assert.throws(() => poseToCameraPose({ ...ok, pos: [1, 2] }, FOV), TypeError);
  assert.throws(() => poseToCameraPose({ ...ok, pos: 'abc' }, FOV), TypeError);
  assert.throws(() => poseToCameraPose({ ...ok, pos: [1, '2', 3] }, FOV), TypeError);
  assert.throws(() => poseToCameraPose({ ...ok, yaw: '0' }, FOV), TypeError);
  assert.throws(() => poseToCameraPose({ pos: [0, 0, 0], yaw: 0 }, FOV), TypeError);
  assert.throws(() => poseToCameraPose(ok, '0.9'), TypeError);
  assert.throws(() => poseToCameraPose(ok), TypeError);
  assert.throws(() => poseToCameraPose({ ...ok, pos: [NaN, 0, 0] }, FOV), RangeError);
  assert.throws(() => poseToCameraPose({ ...ok, pos: [0, Infinity, 0] }, FOV), RangeError);
  assert.throws(() => poseToCameraPose({ ...ok, pos: [0, 0, 1e39] }, FOV), RangeError);
  assert.throws(() => poseToCameraPose({ ...ok, yaw: Infinity }, FOV), RangeError);
  assert.throws(() => poseToCameraPose({ ...ok, pitch: NaN }, FOV), RangeError);
  for (const f of [0, -0.1, Math.PI, 4, NaN, Infinity, 1e-50, 3.14159265]) {
    assert.throws(() => poseToCameraPose(ok, f), RangeError, `fovY ${f}`);
  }
  const before = JSON.stringify(ok);
  const cam = poseToCameraPose(ok, FOV);
  assert.equal(JSON.stringify(ok), before);
  assert.notEqual(cam.pos, ok.pos);
  cam.pos[0] = 99;
  assert.equal(ok.pos[0], 1);
});
