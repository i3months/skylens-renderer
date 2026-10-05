// 드레이프 화소 역투영(unproject.mjs) 시험. 참조 구현은 server/raster_ref/project(시험 전용 사용).
// 기준 수치: 복원 오차 ≤ 1e-6 m(UNPROJECT_TOL_M), 손계산 리터럴은 1e-12.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pixelToEnu } from './unproject.mjs';
import { project } from '../../../server/raster_ref/project/index.mjs';

const UNPROJECT_TOL_M = 1e-6;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};
const dist = (p, q) => Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2]);

// ENU 월드에서 eye → target 을 보는 OpenCV 축 카메라(x 오른쪽, y 아래, z 앞). roll 은 광축 둘레 회전(rad).
function lookAt(eye, target, { width, height, K, roll = 0 }) {
  const f = unit(sub(target, eye));
  let r = unit(cross(f, [0, 0, 1]));
  let d = cross(f, r);
  const c = Math.cos(roll), s = Math.sin(roll);
  [r, d] = [[c * r[0] + s * d[0], c * r[1] + s * d[1], c * r[2] + s * d[2]], [-s * r[0] + c * d[0], -s * r[1] + c * d[1], -s * r[2] + c * d[2]]];
  const R = [...r, ...d, ...f];
  const t = [-(R[0] * eye[0] + R[1] * eye[1] + R[2] * eye[2]), -(R[3] * eye[0] + R[4] * eye[1] + R[5] * eye[2]), -(R[6] * eye[0] + R[7] * eye[1] + R[8] * eye[2])];
  return { width, height, K, R, t };
}

// 축 회전 세 개의 곱(Rz·Ry·Rx)으로 만든 일반 회전 카메라
function eulerCamera(ax, ay, az, t, { width, height, K }) {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  const R = [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
  return { width, height, K, R, t };
}

const K160 = { fx: 125.72, fy: 125.64, cx: 80, cy: 45 };
// 해상도 2 배 + 비정방 화소·주점 이동(K 스케일이 다른 경우)
const K320 = { fx: 251.44 * 1.1, fy: 251.28, cx: 163.5, cy: 88.25 };

const CAMERAS = [
  { name: '관제탑 내려보기 160×90', cam: lookAt([10, -60, 45], [0, 20, 3], { width: 160, height: 90, K: K160 }) },
  { name: '북동 시선 roll 0.3 160×90', cam: lookAt([-80, -70, 25], [30, 40, 0], { width: 160, height: 90, K: K160, roll: 0.3 }) },
  { name: '일반 회전(Euler) 160×90', cam: eulerCamera(-1.9, 0.4, 2.3, [3.5, -7.25, 60], { width: 160, height: 90, K: K160 }) },
  { name: '서쪽 시선 roll −0.5 320×180 다른 K', cam: lookAt([120, 15, 70], [-10, -5, 2], { width: 320, height: 180, K: K320, roll: -0.5 }) },
];

// 화면 안에 들어오는 알려진 ENU 점을 결정적으로 고른다(격자 + 높이 변화).
function visiblePoints(cam) {
  const pts = [];
  for (let gx = -100; gx <= 100; gx += 12.5) {
    for (let gy = -100; gy <= 100; gy += 12.5) {
      const p = [gx + 0.37, gy - 0.21, 3 * Math.sin(gx * 0.05) + 2 * Math.cos(gy * 0.07)];
      const { u, v, d } = project(cam, p);
      if (d > 0 && u >= 0 && u < cam.width && v >= 0 && v < cam.height) pts.push({ p, u, v, d });
    }
  }
  return pts;
}

test('손계산: R = I, t = 0 에서 화소 (79, 44) 중심·깊이 10 은 광축 위 (0, 0, 10)', () => {
  const cam = { width: 160, height: 90, K: { fx: 100, fy: 100, cx: 80, cy: 45 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  const p = pixelToEnu(cam, 79.5, 44.5, 10);
  assert.ok(Math.abs(p.x) <= 1e-12 && Math.abs(p.y) <= 1e-12 && Math.abs(p.z - 10) <= 1e-12, JSON.stringify(p));
  // 정수 화소 (0, 0) 중심 (0.5, 0.5): X_c = 10·((0.5−80)/100, (0.5−45)/100, 1) = (−7.95, −4.45, 10)
  const q = pixelToEnu(cam, 0, 0, 10);
  assert.ok(Math.abs(q.x + 7.95) <= 1e-12 && Math.abs(q.y + 4.45) <= 1e-12 && Math.abs(q.z - 10) <= 1e-12, JSON.stringify(q));
});

test('손계산: z 축 90° 회전·t = (1, 2, 3) 에서 Rᵀ(X_c − t)', () => {
  // X_w = (2, 3, 4) → X_c = (−2, 4, 7), u = 100·(−2)/7 + 50, v = 200·4/7 + 40 (server/raster_ref/project 시험과 같은 예)
  const cam = { width: 100, height: 80, K: { fx: 100, fy: 200, cx: 50, cy: 40 }, R: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [1, 2, 3] };
  const u = 50 - 200 / 7, v = 40 + 800 / 7;
  const p = pixelToEnu(cam, u - 0.5, v - 0.5, 7);
  assert.ok(dist(p, [2, 3, 4]) <= 1e-12, JSON.stringify(p));
});

for (const { name, cam } of CAMERAS) {
  test(`왕복(연속 화소): ${name} — project 로 투영한 점을 ${UNPROJECT_TOL_M} m 이내로 복원`, () => {
    const pts = visiblePoints(cam);
    assert.ok(pts.length >= 20, `화면 안 점이 너무 적다: ${pts.length}`);
    let worst = 0;
    for (const { p, u, v, d } of pts) {
      // 연속 화소 좌표 (u, v) 는 칸 번호 (u − 0.5, v − 0.5) 의 중심이다.
      const q = pixelToEnu(cam, u - 0.5, v - 0.5, d);
      worst = Math.max(worst, dist(q, p));
    }
    assert.ok(worst <= UNPROJECT_TOL_M, `최대 오차 ${worst} m > ${UNPROJECT_TOL_M} m`);
  });

  test(`왕복(정수 화소 중심): ${name} — 칸 중심으로 반올림한 점과 ${UNPROJECT_TOL_M} m 이내`, () => {
    const pts = visiblePoints(cam);
    let worst = 0;
    for (const { p, u, v, d } of pts) {
      const i = Math.floor(u), j = Math.floor(v);
      // 기대값: 같은 깊이에서 칸 중심 (i+0.5, j+0.5) 로 옮긴 점. 원래 점에서 X_c 의 x, y 만 d·Δ/f 만큼 움직인다.
      const { K, R, t } = cam;
      const xc = (d * (i + 0.5 - K.cx)) / K.fx, yc = (d * (j + 0.5 - K.cy)) / K.fy;
      const w = [xc - t[0], yc - t[1], d - t[2]];
      const want = [R[0] * w[0] + R[3] * w[1] + R[6] * w[2], R[1] * w[0] + R[4] * w[1] + R[7] * w[2], R[2] * w[0] + R[5] * w[1] + R[8] * w[2]];
      // 기대 점을 참조 구현으로 다시 투영하면 칸 중심·같은 깊이여야 한다(기대값 자체 검산).
      const back = project(cam, want);
      assert.ok(Math.abs(back.u - (i + 0.5)) <= 1e-9 && Math.abs(back.v - (j + 0.5)) <= 1e-9 && Math.abs(back.d - d) <= 1e-9);
      const q = pixelToEnu(cam, i, j, d);
      worst = Math.max(worst, dist(q, want));
      // 반올림으로 움직인 거리는 칸 반 폭의 대각선(d·√((0.5/fx)²+(0.5/fy)²)) 이하
      const bound = d * Math.hypot(0.5 / K.fx, 0.5 / K.fy) + UNPROJECT_TOL_M;
      assert.ok(dist(q, p) <= bound, `원래 점과의 거리 ${dist(q, p)} > ${bound}`);
    }
    assert.ok(worst <= UNPROJECT_TOL_M, `최대 오차 ${worst} m > ${UNPROJECT_TOL_M} m`);
  });
}

test('음성: depth 0·음수·NaN·Infinity·비수 는 RangeError', () => {
  const cam = CAMERAS[0].cam;
  for (const d of [0, -0, -1, -1e-9, NaN, Infinity, -Infinity, '5', null, undefined]) {
    assert.throws(() => pixelToEnu(cam, 10, 10, d), RangeError, `depth=${String(d)}`);
  }
});

test('음성: i·j 비유한(NaN·±Infinity·비수)은 RangeError', () => {
  const cam = CAMERAS[0].cam;
  for (const bad of [NaN, Infinity, -Infinity, '3', null, undefined]) {
    assert.throws(() => pixelToEnu(cam, bad, 10, 5), RangeError, `i=${String(bad)}`);
    assert.throws(() => pixelToEnu(cam, 10, bad, 5), RangeError, `j=${String(bad)}`);
  }
});

test('음성: 카메라 불량은 assertCamera 의 raster: Error', () => {
  const good = CAMERAS[0].cam;
  const bad = [
    null,
    {},
    { ...good, width: 0 },
    { ...good, K: { ...good.K, fx: 0 } },
    { ...good, K: { ...good.K, cy: NaN } },
    { ...good, R: [1, 0, 0, 0, 1, 0, 0, 0] },
    { ...good, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] },
    { ...good, R: [1, 0, 0, 0, 1, 0, 0, 0, -1] },
    { ...good, t: [0, 0, NaN] },
  ];
  for (const cam of bad) assert.throws(() => pixelToEnu(cam, 10, 10, 5), /^Error: raster:/);
});

test('음성: 넘침으로 결과가 비유한이면 RangeError', () => {
  const cam = { ...CAMERAS[0].cam };
  assert.throws(() => pixelToEnu(cam, 1e308, 10, 1e308), RangeError);
});
