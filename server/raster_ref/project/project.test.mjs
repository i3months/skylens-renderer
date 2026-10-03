// T06.1 투영 시험. 정답은 모두 손계산 리터럴이다(구현을 다시 불러 정답을 만들지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, projectMany } from './index.mjs';

const near = (got, want, tol, msg) =>
  assert.ok(Math.abs(got - want) <= tol, `${msg}: ${got} vs ${want} (허용 ${tol})`);

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// renderer_basis §1-2 의 960px 앞 카메라 K
const BASIS = { width: 960, height: 540, K: { fx: 754.32, fy: 753.85, cx: 480, cy: 270 }, R: I3, t: [0, 0, 0] };

// z 축 90° 회전(행 우선): x_c = −y_w, y_c = x_w, z_c = z_w. t = (1, 2, 3)
const RZ90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
const CAM = { width: 100, height: 80, K: { fx: 100, fy: 200, cx: 50, cy: 40 }, R: RZ90, t: [1, 2, 3] };
// 손계산: X_w = (2, 3, 4) → R·X_w = (−3, 2, 4), +t → X_c = (−2, 4, 7)
//   u = 100·(−2)/7 + 50 = 50 − 200/7 = 21.428571428…
//   v = 200·4/7 + 40 = 40 + 800/7 = 154.285714285…
//   d = 7
const XW = [2, 3, 4];
const WANT = { u: 21.428571428571427, v: 154.28571428571428, d: 7 };

test('renderer_basis §2-3 예제: X_c = (−5.03, −7.84, 45.28), R = I, t = 0', () => {
  const { u, v, d } = project(BASIS, [-5.03, -7.84, 45.28]);
  near(d, 45.28, 1e-12, 'd');
  // 직접 검산: u = 754.32·(−5.03)/45.28 + 480 = 480 − 3794.2296/45.28 = 396.205176…
  //            v = 753.85·(−7.84)/45.28 + 270 = 270 − 5910.184/45.28 = 139.474735…
  near(u, 396.2052, 0.01, 'u(직접 검산)');
  near(v, 139.47, 0.01, 'v(문서 값)');
  // 문서 표의 u = 396.27 은 반올림 전 X_c 로 낸 값이다. X_c.x 를 0.01 m 로 반올림하면
  // u 가 최대 754.32·0.005/45.28 ≈ 0.083 px 움직이므로 그 범위 안에서만 맞춘다.
  // 반올림 한계(성분 합): x 항 fx·0.005/d = 0.083 px, z 항 fx·|x|·0.005/d² = 754.32·5.03·0.005/45.28² ≈ 0.009 px
  // 이므로 반올림된 입력으로는 0.092 px 까지만 보장한다.
  near(u, 396.27, 0.092, 'u(문서 값, 반올림 오차 범위: x 항 + z 항)');
});

test('renderer_basis §2-3 예제: 반올림 전 X_c = (−5.02611, −7.84, 45.28) 은 문서 값과 0.01 px 이내', () => {
  const { u, v } = project(BASIS, [-5.02611, -7.84, 45.28]);
  near(u, 396.27, 0.01, 'u(문서 396.27)');
  near(v, 139.47, 0.01, 'v(문서 139.47)');
  // 변이: u 에 0.05 px 오프셋이 생기면 위 허용(0.01)을 넘어야 한다(시험이 그 오프셋을 잡는다는 증명).
  assert.ok(Math.abs(u + 0.05 - 396.27) > 0.01, '0.05 px 오프셋 변이가 통과함');
  assert.ok(Math.abs(v + 0.05 - 139.47) > 0.01, 'v 0.05 px 오프셋 변이가 통과함');
});

test('비자명 R(z 축 90°)과 t ≠ 0 손계산', () => {
  const { u, v, d } = project(CAM, XW);
  near(u, WANT.u, 1e-12, 'u');
  near(v, WANT.v, 1e-12, 'v');
  near(d, WANT.d, 1e-12, 'd');
  // 형식 배열 입력도 받는다
  const p = project(CAM, new Float64Array(XW));
  near(p.u, WANT.u, 1e-12, 'u(Float64Array)');
});

test('카메라 뒤·카메라 평면 위 점은 d 만 주고 u, v 는 NaN', () => {
  // X_w = (0, 0, −5) → X_c.z = −5 + 3 = −2
  const back = project(CAM, [0, 0, -5]);
  assert.equal(back.d, -2);
  assert.ok(Number.isNaN(back.u) && Number.isNaN(back.v));
  // X_w = (0, 0, −3) → d = 0
  const zero = project(CAM, [0, 0, -3]);
  assert.equal(zero.d, 0);
  assert.ok(Number.isNaN(zero.u) && Number.isNaN(zero.v));
  // d 가 극히 작으면(예: 1e-310) u, v 가 ±Infinity 가 되는데 이를 NaN 으로 통일
  const tiny = project({ ...CAM, R: I3, t: [0, 0, 0] }, [1, 1, 1e-310]);
  assert.ok(Number.isNaN(tiny.u) && Number.isNaN(tiny.v), '극히 작은 d → u, v NaN');
  // 일반적인 아주 작은 양수(d = 1e-9 > 0)는 유한한 u, v
  const small = project({ ...CAM, R: I3, t: [0, 0, 0] }, [0, 0, 1e-9]);
  assert.ok(Number.isFinite(small.u) && Number.isFinite(small.v));
});

// 변이 구현: 시험이 흔한 실수를 잡는지 확인한다. 각 변이는 손계산 정답과 어긋나야 한다.
function mutantProject(camera, xw, { flipV = false, transposeR = false } = {}) {
  const r = camera.R;
  const R = transposeR ? [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]] : r;
  const [x, y, z] = xw;
  const xc = R[0] * x + R[1] * y + R[2] * z + camera.t[0];
  const yc = R[3] * x + R[4] * y + R[5] * z + camera.t[1];
  const d = R[6] * x + R[7] * y + R[8] * z + camera.t[2];
  const fy = flipV ? -camera.K.fy : camera.K.fy;
  return { u: (camera.K.fx * xc) / d + camera.K.cx, v: (fy * yc) / d + camera.K.cy, d };
}

test('변이(v 에 −fy, R 전치)는 손계산 정답을 통과하지 못한다', () => {
  const matches = (p) => Math.abs(p.u - WANT.u) <= 1e-6 && Math.abs(p.v - WANT.v) <= 1e-6 && Math.abs(p.d - WANT.d) <= 1e-6;
  // 변이 없는 복제본은 통과해야 시험 자체가 의미 있다
  assert.ok(matches(mutantProject(CAM, XW)), '변이 없는 복제본');
  // −fy: v = 40 − 800/7 = −74.2857…
  const f = mutantProject(CAM, XW, { flipV: true });
  assert.ok(!matches(f), 'v 부호 반전이 통과함');
  near(f.v, -74.28571428571429, 1e-9, '−fy 변이의 v');
  // Rᵀ: X_c = (3 + 1, −2 + 2, 7) = (4, 0, 7) → u = 50 + 400/7 = 107.1428…, v = 40
  const tr = mutantProject(CAM, XW, { transposeR: true });
  assert.ok(!matches(tr), 'R 전치가 통과함');
  near(tr.u, 107.14285714285714, 1e-9, 'Rᵀ 변이의 u');
  near(tr.v, 40, 1e-9, 'Rᵀ 변이의 v');
  // 실제 구현은 통과한다
  assert.ok(matches(project(CAM, XW)), '실제 구현');
});

test('projectMany 는 점마다 project 와 같다', () => {
  // Float32 로 정확히 표현되는 좌표만 쓴다(손계산 정답과 비교하려고)
  const pts = [[2, 3, 4], [0, 0, -5], [0.5, -1.25, 10], [-3, 0.75, 0.5], [0, 0, -3]];
  const pos = new Float32Array(pts.flat());
  const out = new Float64Array(pos.length);
  const ret = projectMany(CAM, pos, out);
  assert.equal(ret, out);
  // 첫 점은 손계산 정답과 일치
  near(out[0], WANT.u, 1e-12, 'u0');
  near(out[1], WANT.v, 1e-12, 'v0');
  near(out[2], WANT.d, 1e-12, 'd0');
  for (let i = 0; i < pts.length; i += 1) {
    const p = project(CAM, pts[i]);
    for (const [k, got] of [['u', out[3 * i]], ['v', out[3 * i + 1]], ['d', out[3 * i + 2]]]) {
      if (Number.isNaN(p[k])) assert.ok(Number.isNaN(got), `점 ${i} ${k} NaN`);
      else assert.equal(got, p[k], `점 ${i} ${k}`);
    }
  }
  // 무작위 비정수 Float32 좌표에서도 비트 단위로 같다
  const m = 200;
  const rp = new Float32Array(3 * m);
  let s = 12345;
  for (let i = 0; i < rp.length; i += 1) { s = (s * 1103515245 + 12345) >>> 0; rp[i] = (s / 4294967296) * 40 - 20; }
  const ro = projectMany(BASIS, rp, new Float64Array(3 * m));
  for (let i = 0; i < m; i += 1) {
    const p = project(BASIS, [rp[3 * i], rp[3 * i + 1], rp[3 * i + 2]]);
    assert.ok(Object.is(ro[3 * i], p.u) && Object.is(ro[3 * i + 1], p.v) && Object.is(ro[3 * i + 2], p.d), `무작위 점 ${i}`);
  }
  // 빈 입력
  assert.equal(projectMany(CAM, new Float32Array(0), new Float64Array(0)).length, 0);
});

test('거부 입력은 raster: Error', () => {
  const bad = (fn) => assert.throws(fn, (e) => e instanceof Error && e.message.startsWith('raster:'));
  // 카메라(assertCamera)
  bad(() => project(null, XW));
  bad(() => project({ ...CAM, width: 0 }, XW));
  bad(() => project({ ...CAM, K: { ...CAM.K, fx: -1 } }, XW));
  bad(() => project({ ...CAM, R: [1, 0, 0, 0, 1, 0, 0, 0, -1] }, XW)); // det = −1
  bad(() => project({ ...CAM, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] }, XW)); // 정규직교 아님
  bad(() => project({ ...CAM, t: [0, 0] }, XW));
  // xw
  bad(() => project(CAM, null));
  bad(() => project(CAM, [1, 2]));
  bad(() => project(CAM, [1, 2, 3, 4]));
  bad(() => project(CAM, [1, NaN, 3]));
  bad(() => project(CAM, [1, 2, Infinity]));
  bad(() => project(CAM, [1, '2', 3]));
  bad(() => project(CAM, { 0: 1, 1: 2, 2: 3, length: 3 }));
  // projectMany
  bad(() => projectMany(CAM, [1, 2, 3], new Float64Array(3)));
  bad(() => projectMany(CAM, new Float64Array(3), new Float64Array(3)));
  bad(() => projectMany(CAM, new Float32Array(4), new Float64Array(4)));
  bad(() => projectMany(CAM, new Float32Array(3), new Float32Array(3)));
  bad(() => projectMany(CAM, new Float32Array(6), new Float64Array(3)));
  bad(() => projectMany(CAM, new Float32Array([1, NaN, 3]), new Float64Array(3)));
  bad(() => projectMany({ ...CAM, height: 1.5 }, new Float32Array(3), new Float64Array(3)));
});
