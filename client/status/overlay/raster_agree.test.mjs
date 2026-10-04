// 마커 위치가 래스터라이저가 그린 점과 같은 화면 위치에 오는지 보는 독립 기준 시험.
// project → unproject 왕복은 두 함수가 같은 R·K 를 쓰므로 함께 틀려도(R↔Rᵀ 등) 통과한다. 여기서는
//   (1) syncCamera(pose, size(dpr ≠ 1)) 로 만든 view 를 projectMarkers 와 client/raster 의
//       buildCameraUniforms + projectWithUniforms(장치 픽셀, ÷dpr 해서 CSS 픽셀) 에 함께 넣어 같은 ENU 점을 비교하고
//   (2) renderer_basis §2-3 의 실제 점(기준 사진 camF_0030) 의 공개된 깊이·픽셀과 비교한다.
// 화면 차는 미터로 바꿔(Δpx·d/f) 본다. 기준값은 시험 안의 숫자다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMarkers, unprojectToEnu } from './index.mjs';
import { syncCamera, quatToMatrix } from '../camera/index.mjs';
import { buildCameraUniforms, projectWithUniforms } from '../../raster/camera/index.mjs';

/** 마커와 래스터 화면 위치 차의 상한(m). 계약의 1 cm. */
const MAX_DIFF_M = 0.01;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};

/** 행 우선 회전 행렬 → 단위 쿼터니언(x,y,z,w). Shepperd 방식(대각합·대각 원소 중 가장 큰 것으로 나눈다). */
function matrixToQuat(M) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = M;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 2 * Math.sqrt(tr + 1);
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
}

/** 래스터 유니폼 경로로 투영하고 장치 픽셀을 ÷dpr 해서 CSS 픽셀로. 카메라 뒤면 null. */
function rasterCss(U, dpr, X) {
  const p = projectWithUniforms(U, X);
  if (p === null) return null;
  return { u: p.u / dpr, v: p.v / dpr, d: p.d };
}

/** 마커 결과와 래스터 결과의 화면 차를 미터로(Δpx·d/f, f = CSS 픽셀 초점거리). */
function diffMeters(m, r, K) {
  const du = Math.abs(m.u - r.u) * r.d / K.fx;
  const dv = Math.abs(m.v - r.v) * r.d / K.fy;
  return Math.hypot(du, dv);
}

const SIZES = [
  { width: 960, height: 540, devicePixelRatio: 2 }, // 그리기 버퍼 1920×1080
  { width: 960, height: 540, devicePixelRatio: 1.5 }, // 1440×810
  { width: 1280, height: 720, devicePixelRatio: 1.5 }, // 1920×1080
];

test('무작위 자세·dpr 2·1.5: projectMarkers 와 래스터 유니폼 투영의 화면 차 ≤ 0.01 m', () => {
  const rnd = mulberry32(20261004);
  for (const size of SIZES) {
    for (let k = 0; k < 20; k += 1) {
      const quat = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const pos = [rnd() * 2000 - 1000, rnd() * 2000 - 1000, 20 + rnd() * 200];
      const pose = { pos, quat, fovY: 0.4 + rnd() * 1.2 };
      const { view } = syncCamera(pose, size, k);
      const U = buildCameraUniforms(view);
      assert.equal(U.bw, Math.round(size.width * size.devicePixelRatio));
      // 카메라→ENU 회전 열로 카메라 앞 점을 세계 좌표에서 직접 만든다(view.R 을 쓰지 않는다).
      const C = quatToMatrix(unit(quat));
      const markers = [];
      for (let i = 0; i < 25; i += 1) {
        const d = 3 + rnd() * 800;
        const a = (rnd() * 2 - 1) * 0.9 * d;
        const b = (rnd() * 2 - 1) * 0.6 * d;
        // X_w = pos + C·[a, b, d]
        const enu = [0, 1, 2].map((r) => pos[r] + C[3 * r] * a + C[3 * r + 1] * b + C[3 * r + 2] * d);
        markers.push({ id: `${k}.${i}`, enu });
      }
      const out = projectMarkers(view, markers);
      out.forEach((m, i) => {
        const r = rasterCss(U, size.devicePixelRatio, markers[i].enu);
        assert.notEqual(r, null, `래스터가 점 ${m.id} 를 카메라 뒤로 봄`);
        assert.ok(Math.abs(m.depth - r.d) <= 1e-6 * r.d, `depth ${m.id}: ${m.depth} vs ${r.d}`);
        const e = diffMeters(m, r, view.K);
        assert.ok(e <= MAX_DIFF_M, `점 ${m.id} dpr ${size.devicePixelRatio}: 화면 차 ${e} m (마커 ${m.u},${m.v} 래스터 ${r.u},${r.v})`);
        // 래스터의 화면 안 판정과 visible 이 같아야 한다(경계에서 1e-9 px 안쪽 점은 없다고 보고 그대로 비교).
        const inside = r.u >= 0 && r.u < view.width && r.v >= 0 && r.v < view.height;
        assert.equal(m.visible, inside, `visible ${m.id}`);
      });
    }
  }
});

// renderer_basis §1-2·1-3·2-3 의 공개 값(기준 사진 camF_0030, 960×540 핀홀).
//   K: fx = 754.32, fy = 753.85, cx = 480, cy = 270
//   카메라 중심 C = (1.71, −7.76, 0.08) m, 광축(세계) Rᵀ(0,0,1) = (0.101, −0.490, −0.866)
//   점 X_w = (13.15, −35.04, −35.45) m → X_c = (−5.03, −7.84, 45.28), 픽셀 (396.27, 139.47)
// 공개 값에 R 전체는 없으므로 R 은 광축(셋째 행)과, 광축 둘레 굴림각을 공개된 X_c 의 (x, y) 방향에 맞춰 만든다.
// 굴림각은 X_c 의 x·y 크기를 바꾸지 않으므로 깊이·|(x,y)| 와 픽셀(K 를 거친 값)은 여전히 독립된 확인이다.
// 허용치(사전 산정): 공개 값이 소수 둘째·셋째 자리에서 반올림돼 있다. 광축 3자리 → 방향 오차 ~1e-3 rad → 46 m 에서
// ~0.05 m(≈0.8 px), X_w·C 2자리 → ≤ 0.02 m. syncCamera 는 fx = fy 라 fx 754.32 대신 753.85 를 쓰는 차가
// 754.32−753.85 = 0.47 px × |X_c.x/d| 0.11 ≈ 0.05 px. 합쳐 1 px(46 m 에서 약 0.06 m), 깊이 0.05 m 로 잡는다.
const BASIS = {
  C: [1.71, -7.76, 0.08],
  axis: [0.101, -0.49, -0.866],
  X: [13.15, -35.04, -35.45],
  Xc: [-5.03, -7.84, 45.28],
  pixel: [396.27, 139.47],
  fy: 753.85,
  width: 960,
  height: 540,
};

function basisRotation() {
  const z = unit(BASIS.axis);
  const x0 = unit(cross(z, [0, 0, 1])); // 굴림 없는 x(수평)
  const y0 = cross(z, x0);
  const D = BASIS.X.map((c, i) => c - BASIS.C[i]);
  const th = Math.atan2(BASIS.Xc[1], BASIS.Xc[0]) - Math.atan2(dot(y0, D), dot(x0, D));
  const c = Math.cos(th);
  const s = Math.sin(th);
  // 광축 둘레로 θ 만큼 돌린 카메라 x·y 축(세계 좌표)
  const x = x0.map((v, i) => c * v - s * y0[i]);
  const y = x0.map((v, i) => s * v + c * y0[i]);
  return [...x, ...y, ...z]; // 행 = 카메라 축, 세계→카메라
}

for (const dpr of [2, 1.5]) {
  test(`renderer_basis §2-3 실제 점(camF_0030), dpr ${dpr}: 공개 깊이·픽셀과 맞고 래스터와 0.01 m 이내`, () => {
    const R = basisRotation();
    const fovY = 2 * Math.atan((BASIS.height / 2) / BASIS.fy);
    const quat = matrixToQuat([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]); // 카메라→ENU = Rᵀ
    const { view } = syncCamera({ pos: BASIS.C, quat, fovY }, { width: BASIS.width, height: BASIS.height, devicePixelRatio: dpr }, 1);
    for (let i = 0; i < 9; i += 1) assert.ok(Math.abs(view.R[i] - R[i]) <= 1e-12, `view.R[${i}]`);
    assert.ok(Math.abs(view.K.fy - 753.85) <= 1e-9);
    const [m] = projectMarkers(view, [{ id: 'camF_0030', enu: BASIS.X }]);
    // 공개 값과 비교
    assert.ok(Math.abs(m.depth - 45.28) <= 0.05, `depth ${m.depth}`);
    assert.ok(Math.abs(m.u - 396.27) <= 1, `u ${m.u}`);
    assert.ok(Math.abs(m.v - 139.47) <= 1, `v ${m.v}`);
    assert.equal(m.visible, true);
    // 래스터와 비교(같은 view)
    const U = buildCameraUniforms(view);
    const r = rasterCss(U, dpr, BASIS.X);
    const e = diffMeters(m, r, view.K);
    assert.ok(e <= MAX_DIFF_M, `래스터와 화면 차 ${e} m`);
    // 래스터 값도 공개 픽셀과 맞는지(래스터 쪽 규약 확인)
    assert.ok(Math.abs(r.u - 396.27) <= 1 && Math.abs(r.v - 139.47) <= 1, `raster ${r.u},${r.v}`);
    // 공개 픽셀·깊이를 되돌리면 공개 X_w 근처(같은 반올림 허용치: 1 px·46 m/754 + 0.05 ≈ 0.12 m)
    const back = unprojectToEnu(view, 396.27, 139.47, 45.28);
    const err = Math.hypot(...back.map((b, i) => b - BASIS.X[i]));
    assert.ok(err <= 0.12, `공개 픽셀 역투영 오차 ${err} m`);
  });
}
