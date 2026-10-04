import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCameraUniforms, cssViewIntrinsics, projectWithUniforms } from './index.mjs';
import { ClientRasterError, fitIntrinsics, scaleIntrinsics } from '../../../contracts/client_raster/index.mjs';

// 성공 기준: 해상도·dpr 을 바꿔도 같은 세계 점의 투영 위치가 CSS 픽셀로 ≤ 0.5 px 일치
const TOL_CSS_PX = 0.5;

// renderer_basis §1-2 앞 카메라 실제 K(원본 2048×1152)
const REF_W = 2048;
const REF_H = 1152;
const K_REF = Object.freeze({ fx: 1609.22, fy: 1608.21, cx: 1024, cy: 576 });

// 시험 화면: [CSS 너비, CSS 높이, dpr]
const SCREENS = [
  [375, 667, 3],
  [2048, 1152, 1],
  [1024, 576, 2],
  [667, 375, 3],
  [333, 222, 1.25],
  [1920, 1080, 1.5],
  [412, 915, 2.625],
  [800, 800, 1],
];

// 고정 시드 PRNG(mulberry32)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 축-각 → 행 우선 회전 행렬(로드리게스)
function rotation(axis, ang) {
  const n = Math.hypot(...axis);
  const [x, y, z] = axis.map((a) => a / n);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

// 기준 카메라 자세: 임의 회전과 카메라 중심 C, t = −R·C
const R0 = rotation([0.3, -0.8, 0.5], 1.1);
const C0 = [1.71, -7.76, 0.08];
const T0 = [0, 1, 2].map((i) => -(R0[i * 3] * C0[0] + R0[i * 3 + 1] * C0[1] + R0[i * 3 + 2] * C0[2]));

// 합성 세계 점: 기준 영상 안쪽(경계 5% 안)에 투영되는 점을 깊이 5..80 m 에서 뽑아 역투영한다.
function syntheticPoints(n, seed) {
  const r = rng(seed);
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const u = REF_W * (0.05 + 0.9 * r());
    const v = REF_H * (0.05 + 0.9 * r());
    const d = 5 + 75 * r();
    const xc = [((u - K_REF.cx) / K_REF.fx) * d, ((v - K_REF.cy) / K_REF.fy) * d, d];
    // X_w = Rᵀ(X_c − t)
    const q = [xc[0] - T0[0], xc[1] - T0[1], xc[2] - T0[2]];
    pts.push([0, 1, 2].map((j) => R0[j] * q[0] + R0[3 + j] * q[1] + R0[6 + j] * q[2]));
  }
  return pts;
}

// 정답(유니폼과 독립인 식): 기준 영상 픽셀 (uR, vR) 를 CSS 화면에 중앙 맞춤으로 옮긴다.
//   s = min|max(W/refW, H/refH), u = s·uR + (W − s·refW)/2
function truthCss(Xw, W, H, mode) {
  const x = R0[0] * Xw[0] + R0[1] * Xw[1] + R0[2] * Xw[2] + T0[0];
  const y = R0[3] * Xw[0] + R0[4] * Xw[1] + R0[5] * Xw[2] + T0[1];
  const d = R0[6] * Xw[0] + R0[7] * Xw[1] + R0[8] * Xw[2] + T0[2];
  const uR = K_REF.fx * (x / d) + K_REF.cx;
  const vR = K_REF.fy * (y / d) + K_REF.cy;
  const s = mode === 'cover' ? Math.max(W / REF_W, H / REF_H) : Math.min(W / REF_W, H / REF_H);
  return [s * uR + (W - s * REF_W) / 2, s * vR + (H - s * REF_H) / 2];
}

function viewFor(W, H, dpr, mode = 'contain') {
  return { R: R0, t: T0, K: cssViewIntrinsics(K_REF, REF_W, REF_H, W, H, mode), width: W, height: H, devicePixelRatio: dpr };
}

// 장치 픽셀 → CSS 픽셀(축마다 버퍼/CSS 비)
function toCss(p, U, W, H) {
  return [(p.u * W) / U.bw, (p.v * H) / U.bh];
}

// NDC → CSS 픽셀(셰이더 출력에서 거꾸로)
function ndcToCss(ndc, W, H) {
  return [((ndc[0] + 1) / 2) * W, ((1 - ndc[1]) / 2) * H];
}

const POINTS = syntheticPoints(400, 12_4);

test('기준값: renderer_basis §2-3 예제 점(960×540 K, R = I, t = 0)', () => {
  const U = buildCameraUniforms({
    R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0],
    K: { fx: 754.32, fy: 753.85, cx: 480, cy: 270 }, width: 960, height: 540, devicePixelRatio: 1,
  });
  assert.deepEqual([U.bw, U.bh], [960, 540]);
  assert.deepEqual(U.Rgl, [1, 0, 0, -0, -1, -0, -0, -0, -1]);
  const p = projectWithUniforms(U, [-5.03, -7.84, 45.28]);
  // 반올림된 X_c 로 계산한 값. 문서 값 (396.27, 139.47) 과는 X_c 반올림만큼(< 0.1 px) 다르다.
  assert.ok(Math.abs(p.u - 396.2052) < 1e-3, `u=${p.u}`);
  assert.ok(Math.abs(p.v - 139.4747) < 1e-3, `v=${p.v}`);
  assert.ok(Math.abs(p.u - 396.27) < 0.1 && Math.abs(p.v - 139.47) < 0.1);
  assert.ok(Math.abs(p.d - 45.28) < 1e-12);
});

test('기준값: 2048×1152 K → 375×667@3 (contain = 가로 맞춤)', () => {
  const K = cssViewIntrinsics(K_REF, REF_W, REF_H, 375, 667);
  // s = 375/2048, cy = s·576 + (667 − s·1152)/2 = 333.5
  assert.ok(Math.abs(K.fx - 294.656982421875) < 1e-9);
  assert.ok(Math.abs(K.fy - 294.4720458984375) < 1e-9);
  assert.equal(K.cx, 187.5);
  assert.equal(K.cy, 333.5);
  const U = buildCameraUniforms({ R: R0, t: T0, K, width: 375, height: 667, devicePixelRatio: 3 });
  assert.deepEqual([U.bw, U.bh], [1125, 2001]);
  assert.ok(Math.abs(U.fx - 883.970947265625) < 1e-9);
  assert.ok(Math.abs(U.fy - 883.4161376953125) < 1e-9);
  assert.equal(U.cx, 562.5);
  assert.equal(U.cy, 1000.5);
  // 늘어남 없음: fy/fx 가 기준과 같다(정수 dpr 이라 버퍼 반올림 없음)
  assert.ok(Math.abs(U.fy / U.fx - K_REF.fy / K_REF.fx) < 1e-12);
});

for (const mode of ['contain', 'cover']) {
  test(`해상도·dpr 을 바꿔도 같은 세계 점의 CSS 위치가 정답과 ≤ 0.5 px (${mode})`, () => {
    let worst = 0;
    let checked = 0;
    for (const [W, H, dpr] of SCREENS) {
      const U = buildCameraUniforms(viewFor(W, H, dpr, mode));
      for (const X of POINTS) {
        const p = projectWithUniforms(U, X);
        assert.ok(p, '기준 영상 안의 점은 카메라 앞이다');
        const [tu, tv] = truthCss(X, W, H, mode);
        const [cu, cv] = toCss(p, U, W, H);
        const [nu, nv] = ndcToCss(p.ndc, W, H);
        worst = Math.max(worst, Math.abs(cu - tu), Math.abs(cv - tv), Math.abs(nu - tu), Math.abs(nv - tv));
        checked += 1;
      }
    }
    assert.equal(checked, SCREENS.length * POINTS.length);
    assert.ok(worst <= TOL_CSS_PX, `최대 오차 ${worst} CSS px`);
    // 장치 픽셀로 바꾸고 되돌리는 길이 정확하므로 실제 오차는 부동소수 수준이다
    assert.ok(worst < 1e-6, `최대 오차 ${worst} CSS px`);
  });
}

test('같은 CSS 화면에서 dpr 만 바꾸면 CSS 위치가 정답(truthCss)과 ≤ 0.5 px', () => {
  // 서로 같은 구현끼리(dpr = 1 대 dpr) 비교하면 둘이 함께 틀려도 통과하므로 양쪽 모두 정답과 비교한다.
  let worst = 0;
  for (const [W, H] of [[375, 667], [333, 222], [1920, 1080], [412, 915]]) {
    const U1 = buildCameraUniforms(viewFor(W, H, 1));
    for (const dpr of [1.25, 1.5, 1.75, 2, 2.625, 3, 4]) {
      const U = buildCameraUniforms(viewFor(W, H, dpr));
      for (const X of POINTS) {
        const [tu, tv] = truthCss(X, W, H, 'contain');
        const a = toCss(projectWithUniforms(U1, X), U1, W, H);
        const b = ndcToCss(projectWithUniforms(U, X).ndc, W, H);
        worst = Math.max(worst, Math.abs(a[0] - tu), Math.abs(a[1] - tv), Math.abs(b[0] - tu), Math.abs(b[1] - tv));
      }
    }
  }
  assert.ok(worst <= TOL_CSS_PX, `최대 오차 ${worst} CSS px`);
  assert.ok(worst < 1e-6, `최대 오차 ${worst} CSS px`);
});

// 정답(버퍼 기준): 기준 영상 픽셀을 bw×bh 장치 버퍼에 중앙 맞춤으로 옮긴다. fitIntrinsics 식과 독립인 수식.
function truthDevice(Xw, W, H, dpr) {
  const x = R0[0] * Xw[0] + R0[1] * Xw[1] + R0[2] * Xw[2] + T0[0];
  const y = R0[3] * Xw[0] + R0[4] * Xw[1] + R0[5] * Xw[2] + T0[1];
  const d = R0[6] * Xw[0] + R0[7] * Xw[1] + R0[8] * Xw[2] + T0[2];
  const uR = K_REF.fx * (x / d) + K_REF.cx;
  const vR = K_REF.fy * (y / d) + K_REF.cy;
  const bw = Math.round(W * dpr);
  const bh = Math.round(H * dpr);
  const s = Math.min(bw / REF_W, bh / REF_H);
  return [s * uR + (bw - s * REF_W) / 2, s * vR + (bh - s * REF_H) / 2];
}

function worstVsTruthDevice(K1, U, W, H, dpr) {
  const Ux = { ...U, ...K1 };
  let worst = 0;
  for (const X of POINTS) {
    const p = projectWithUniforms(Ux, X);
    const [tu, tv] = truthDevice(X, W, H, dpr);
    worst = Math.max(worst, Math.abs(p.u - tu), Math.abs(p.v - tv));
  }
  return worst;
}

test('한 단계 fitIntrinsics(…, dpr) 는 정답(truthDevice)과 장치 픽셀 1e-6 이내', () => {
  let worst = 0;
  for (const [W, H, dpr] of SCREENS) {
    const U = buildCameraUniforms(viewFor(W, H, dpr));
    worst = Math.max(worst, worstVsTruthDevice(fitIntrinsics(K_REF, REF_W, REF_H, W, H, dpr), U, W, H, dpr));
  }
  assert.ok(worst < 1e-6, `최대 오차 ${worst} 장치 px`);
});

test('판별력: fitIntrinsics 자리에 scaleIntrinsics 를 바꿔 써도 정답과의 비교가 잡아낸다(667×375@3 에서 약 0.45 장치 px)', () => {
  // 기준 영상과 가로세로비가 거의 같은 화면에서는 두 함수의 차이가 0.5 px 안쪽이라 허용 오차 0.5 로는 놓치지만,
  // 같은 구현끼리가 아니라 정답과 1e-6 으로 비교하면 걸린다.
  const [W, H, dpr] = [667, 375, 3];
  const U = buildCameraUniforms(viewFor(W, H, dpr));
  const sc = worstVsTruthDevice(scaleIntrinsics(K_REF, REF_W, REF_H, W, H, dpr), U, W, H, dpr);
  assert.ok(sc > 0.1 && sc <= 0.5, `scale 대체 오차 ${sc} 장치 px`);
  assert.ok(sc >= 1e-6, '정답 비교 문턱(1e-6)에 걸려야 한다');
  assert.ok(worstVsTruthDevice(fitIntrinsics(K_REF, REF_W, REF_H, W, H, dpr), U, W, H, dpr) < 1e-6);
});

test('float32 유니폼(GPU 정밀도)으로도 CSS 위치 ≤ 0.5 px', () => {
  const f = Math.fround;
  let worst = 0;
  for (const [W, H, dpr] of SCREENS) {
    const U = buildCameraUniforms(viewFor(W, H, dpr));
    const U32 = {
      ...U, Rgl: U.Rgl.map(f), tgl: U.tgl.map(f), fx: f(U.fx), fy: f(U.fy), cx: f(U.cx), cy: f(U.cy),
    };
    for (const X of POINTS) {
      const p = projectWithUniforms(U32, X.map(f));
      const [tu, tv] = truthCss(X, W, H, 'contain');
      const [nu, nv] = ndcToCss(p.ndc, W, H);
      worst = Math.max(worst, Math.abs(nu - tu), Math.abs(nv - tv));
    }
  }
  assert.ok(worst <= TOL_CSS_PX, `최대 오차 ${worst} CSS px`);
});

test('반례: 가로세로비가 다른 화면에 scaleIntrinsics 를 쓰면 장면이 늘어나 0.5 px 를 넘는다', () => {
  // 2048×1152 → 375×667@3 을 scaleIntrinsics 로 옮기면 fy/fx 가 약 3.16 배가 된다(계약 ② (가) 설명)
  const Kbad = scaleIntrinsics(K_REF, REF_W, REF_H, 375, 667, 3);
  const ratio = (Kbad.fy / Kbad.fx) / (K_REF.fy / K_REF.fx);
  assert.ok(Math.abs(ratio - 3.1622) < 1e-3, `ratio=${ratio}`);
  const U = buildCameraUniforms(viewFor(375, 667, 3));
  const Ubad = { ...U, ...Kbad };
  let worst = 0;
  for (const X of POINTS) {
    const [tu, tv] = truthCss(X, 375, 667, 'contain');
    const [nu, nv] = ndcToCss(projectWithUniforms(Ubad, X).ndc, 375, 667);
    worst = Math.max(worst, Math.abs(nu - tu), Math.abs(nv - tv));
  }
  assert.ok(worst > 100, `늘어남 ${worst} CSS px`);
});

test('NDC 규약: 칸 모서리 (0,0) → (−1, 1), (bw, bh) → (1, −1), 광축은 주점', () => {
  const R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const U = buildCameraUniforms({ R, t: [0, 0, 0], K: { fx: 100, fy: 100, cx: 50, cy: 40 }, width: 100, height: 80, devicePixelRatio: 2 });
  assert.deepEqual([U.bw, U.bh, U.fx, U.fy, U.cx, U.cy], [200, 160, 200, 200, 100, 80]);
  // 주점(버퍼 중심)으로 가는 광축 위 점
  assert.deepEqual(projectWithUniforms(U, [0, 0, 10]).ndc, [0, 0]);
  // u = 0, v = 0 으로 가는 점: x/d = −cx/fx, y/d = −cy/fy
  const p0 = projectWithUniforms(U, [-0.5 * 10, -0.4 * 10, 10]);
  assert.ok(Math.abs(p0.ndc[0] + 1) < 1e-12 && Math.abs(p0.ndc[1] - 1) < 1e-12);
  const p1 = projectWithUniforms(U, [0.5 * 10, 0.4 * 10, 10]);
  assert.ok(Math.abs(p1.ndc[0] - 1) < 1e-12 && Math.abs(p1.ndc[1] + 1) < 1e-12);
  // 카메라 뒤·카메라 평면 위는 그리지 않음
  assert.equal(projectWithUniforms(U, [0, 0, -1]), null);
  assert.equal(projectWithUniforms(U, [1, 1, 0]), null);
});

test('view 검증 실패는 ClientRasterError(view)', () => {
  const good = viewFor(375, 667, 3);
  const bad = [
    null,
    undefined,
    42,
    { ...good, R: [1, 0, 0, 0, 1, 0, 0, 0] },
    { ...good, R: [1, 0, 0, 0, 1, 0, 0, 0, NaN] },
    { ...good, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] },
    { ...good, R: [1, 0, 0, 0, 1, 0, 0, 0, -1] },
    { ...good, R: undefined },
    { ...good, t: [0, 0] },
    { ...good, t: [0, Infinity, 0] },
    { ...good, K: undefined },
    { ...good, K: { ...good.K, fx: 0 } },
    { ...good, K: { ...good.K, fy: -1 } },
    { ...good, K: { ...good.K, cx: NaN } },
    { ...good, width: 0 },
    { ...good, width: 375.5 },
    { ...good, height: -1 },
    { ...good, height: '667' },
    { ...good, devicePixelRatio: 0 },
    { ...good, devicePixelRatio: NaN },
    { ...good, devicePixelRatio: Infinity },
    { ...good, devicePixelRatio: undefined },
    { ...good, width: 8000, devicePixelRatio: 3 },
  ];
  for (const v of bad) {
    assert.throws(() => buildCameraUniforms(v), (e) => e instanceof ClientRasterError && e.code === 'view', JSON.stringify(v));
  }
  assert.throws(() => cssViewIntrinsics(K_REF, REF_W, REF_H, 375, 667, 'stretch'), (e) => e instanceof ClientRasterError && e.code === 'view');
});
