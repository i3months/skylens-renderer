// 역투영 시험(T06.2). 투영은 project 모듈을 쓰지 않고 이 파일 안에서 스칼라식으로 직접 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unproject } from './index.mjs';

// 결정적 난수(mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 축-각 회전(행 우선 9개)
function rotAxis(ax, ay, az, ang) {
  const n = Math.hypot(ax, ay, az);
  const x = ax / n; const y = ay / n; const z = az / n;
  const c = Math.cos(ang); const s = Math.sin(ang); const C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

// 시험 안 투영식: X_c = R·X_w + t, u = fx·xc/d + cx, v = fy·yc/d + cy
function projectScalar(cam, p) {
  const { K, R, t } = cam;
  const xc = R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0];
  const yc = R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1];
  const d = R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2];
  return { u: (K.fx * xc) / d + K.cx, v: (K.fy * yc) / d + K.cy, d };
}

const K0 = { fx: 754.32, fy: 753.85, cx: 480, cy: 270 };
const cameras = () => [
  // z 축 90° 회전, t≠0 (R ≠ Rᵀ 이므로 전치 변이를 잡는다)
  { width: 960, height: 540, K: { ...K0 }, R: rotAxis(0, 0, 1, Math.PI / 2), t: [1.5, -2.25, 3] },
  { width: 960, height: 540, K: { fx: 1200, fy: 600, cx: 470.3, cy: 281.7 }, R: rotAxis(0, 0, 1, -Math.PI / 2), t: [-4, 7, 0.5] },
  { width: 2048, height: 1152, K: { fx: 1609.22, fy: 1608.21, cx: 1024, cy: 576 }, R: rotAxis(0.3, -0.8, 0.5, 1.1), t: [10, -3, 25] },
  { width: 640, height: 480, K: { fx: 500, fy: 900, cx: 320, cy: 240 }, R: rotAxis(1, 1, 0, 2.4), t: [0.2, 0.1, -0.3] },
];

// 카메라 앞(d ∈ [1,100] m) 에 무작위 점을 만들고 세계로 되돌려 시험점으로 쓴다
function randomWorldPoints(cam, n, r) {
  const { R, t } = cam;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const d = 1 + 99 * r();
    const xc = (r() - 0.5) * 2 * d;
    const yc = (r() - 0.5) * 2 * d;
    const a = xc - t[0]; const b = yc - t[1]; const c = d - t[2];
    out.push([R[0] * a + R[3] * b + R[6] * c, R[1] * a + R[4] * b + R[7] * c, R[2] * a + R[5] * b + R[8] * c]);
  }
  return out;
}

function maxRoundTripErr(cams, fn, seed) {
  const r = rng(seed);
  let worst = 0;
  for (const cam of cams) {
    for (const p of randomWorldPoints(cam, 1000, r)) {
      const { u, v, d } = projectScalar(cam, p);
      const q = fn(cam, u, v, d);
      worst = Math.max(worst, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
    }
  }
  return worst;
}

test('unproject_roundtrip_1000_points_per_camera', () => {
  const err = maxRoundTripErr(cameras(), unproject, 20261003);
  assert.ok(err <= 1e-6, `왕복 최대 오차 ${err} m`);
});

// renderer_basis §2-3 예제. 문서의 픽셀 (396.27, 139.47) 은 소수 둘째 자리로 반올림된 값이라
// 픽셀 반올림 한계는 성분당 d·0.005/f (x: 45.28·0.005/754.32 = 3.00e-4 m, y: 45.28·0.005/753.85 = 3.00e-4 m)다.
// 기대 X_c 는 반올림 전 값 (−5.02611, −7.84, 45.28) 이고, 허용은 그 한계에 여유 3% 만 둔 3.1e-4 m 다.
const BASIS_CAM = { width: 960, height: 540, K: { ...K0 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const BASIS_XC = [-5.02611, -7.84, 45.28];
const BASIS_TOL = 3.1e-4;

function maxBasisErr(fn) {
  const q = fn(BASIS_CAM, 396.27, 139.47, 45.28);
  return Math.max(...q.map((x, i) => Math.abs(x - BASIS_XC[i])));
}

test('unproject_basis_example_reproduces_xc', () => {
  // R=I, t=0 이면 X_w = X_c.
  const err = maxBasisErr(unproject);
  assert.ok(err <= BASIS_TOL, `성분 최대 오차 ${err} m > ${BASIS_TOL}`);
});

test('unproject_basis_example_mutant_pixel_offset_fails', () => {
  // 변이: 픽셀 u 에 0.05 px 오프셋 → x 가 d·0.05/fx = 3.0e-3 m 어긋나 허용(3.1e-4)을 넘어야 한다.
  const err = maxBasisErr((cam, u, v, d) => unproject(cam, u + 0.05, v, d));
  assert.ok(err > BASIS_TOL, `변이가 통과함: ${err}`);
  const errV = maxBasisErr((cam, u, v, d) => unproject(cam, u, v - 0.05, d));
  assert.ok(errV > BASIS_TOL, `v 변이가 통과함: ${errV}`);
});

test('unproject_mutants_fail_roundtrip', () => {
  // 변이 1: Rᵀ 대신 R 을 곱함
  const noTranspose = (cam, u, v, d) => {
    const { K, R, t } = cam;
    const a = (d * (u - K.cx)) / K.fx - t[0]; const b = (d * (v - K.cy)) / K.fy - t[1]; const c = d - t[2];
    return [R[0] * a + R[1] * b + R[2] * c, R[3] * a + R[4] * b + R[5] * c, R[6] * a + R[7] * b + R[8] * c];
  };
  // 변이 2: fx 와 fy 를 바꿔 씀
  const swapF = (cam, u, v, d) => unproject({ ...cam, K: { ...cam.K, fx: cam.K.fy, fy: cam.K.fx } }, u, v, d);
  assert.ok(maxRoundTripErr(cameras(), noTranspose, 7) > 1e-3);
  assert.ok(maxRoundTripErr(cameras(), swapF, 7) > 1e-3);
  // z 축 90° 카메라 하나만으로도 전치 변이가 드러나야 한다
  assert.ok(maxRoundTripErr([cameras()[0]], noTranspose, 9) > 1e-3);
});

test('unproject_rejects_bad_depth_and_camera', () => {
  const cam = cameras()[0];
  for (const d of [0, -1, NaN, Infinity, -Infinity, '3', undefined]) {
    assert.throws(() => unproject(cam, 100, 100, d), /^Error: raster:/);
  }
  assert.throws(() => unproject(cam, NaN, 100, 5), /^Error: raster:/);
  assert.throws(() => unproject(cam, 100, Infinity, 5), /^Error: raster:/);
  assert.throws(() => unproject({ ...cam, R: [1, 0, 0, 0, 1, 0, 0, 0, -1] }, 1, 1, 1), /^Error: raster:/);
  assert.throws(() => unproject(null, 1, 1, 1), /^Error: raster:/);
});
