import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCamera, quatToMatrix } from './index.mjs';
import { encodeMessage } from '../../proto/index.mjs';
import { decodeMessage as serverDecode } from '../../../server/proto/codec/index.mjs';
import { buildCameraUniforms, projectWithUniforms } from '../../raster/camera/index.mjs';

// 해석적 사례로 검증한다(원본 skylens 시험 사례 대조는 사람 몫).
const SIZE = Object.freeze({ width: 800, height: 600, devicePixelRatio: 1 });

// contracts/raster 투영: X_c = R·X_w + t, u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy (d = X_c.z)
function toCam(view, X) {
  const { R, t } = view;
  return [0, 1, 2].map((i) => R[i * 3] * X[0] + R[i * 3 + 1] * X[1] + R[i * 3 + 2] * X[2] + t[i]);
}
function project(view, X) {
  const c = toCam(view, X);
  return { u: view.K.fx * c[0] / c[2] + view.K.cx, v: view.K.fy * c[1] / c[2] + view.K.cy, d: c[2] };
}
// X_w = Rᵀ(X_c − t)
function toWorld(view, c) {
  const { R, t } = view;
  const d = [c[0] - t[0], c[1] - t[1], c[2] - t[2]];
  return [0, 1, 2].map((j) => R[j] * d[0] + R[3 + j] * d[1] + R[6 + j] * d[2]);
}
function near(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (허용 ${tol})`);
}

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

test('항등 자세: R=I, t=0, 앞 점은 화면 중심', () => {
  const { view } = syncCamera({ pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: Math.PI / 3 }, SIZE, 0);
  assert.deepEqual(view.R, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(view.t, [0, 0, 0]);
  assert.equal(view.K.cx, 400);
  assert.equal(view.K.cy, 300);
  assert.equal(view.width, 800);
  assert.equal(view.height, 600);
  assert.equal(view.devicePixelRatio, 1);
  const p = project(view, [0, 0, 10]);
  near(p.u, 400, 1e-9, 'u');
  near(p.v, 300, 1e-9, 'v');
  near(p.d, 10, 1e-12, 'd');
});

// 동쪽을 바라보는 자세: 카메라 z→ENU +x, 카메라 x(오른쪽)→ENU −y(남), 카메라 y(아래)→ENU −z.
// R_c2w 열 = [(0,−1,0), (0,0,−1), (1,0,0)] → 행렬 [[0,0,1],[−1,0,0],[0,−1,0]], trace 0
// → w = 0.5, x = (M21−M12)/4w = −0.5, y = (M02−M20)/4w = 0.5, z = (M10−M01)/4w = −0.5.
const EAST_QUAT = Object.freeze([-0.5, 0.5, -0.5, 0.5]);

test('동쪽 자세: 쿼터니언 구성 확인과 투영 방향', () => {
  const C = quatToMatrix(EAST_QUAT);
  const expectC = [0, 0, 1, -1, 0, 0, 0, -1, 0];
  for (let i = 0; i < 9; i += 1) near(C[i], expectC[i], 1e-15, `R_c2w[${i}]`);

  const pos = [100, 200, 30];
  const { view } = syncCamera({ pos, quat: EAST_QUAT, fovY: Math.PI / 2 }, SIZE, 7);
  // view.R = R_c2wᵀ = [[0,−1,0],[0,0,−1],[1,0,0]]
  const expectR = [0, -1, 0, 0, 0, -1, 1, 0, 0];
  for (let i = 0; i < 9; i += 1) near(view.R[i], expectR[i], 1e-15, `R[${i}]`);
  // t = −R·pos = −[−200, −30, 100] = [200, 30, −100]
  near(view.t[0], 200, 1e-12, 't0');
  near(view.t[1], 30, 1e-12, 't1');
  near(view.t[2], -100, 1e-12, 't2');

  const ahead = project(view, [110, 200, 30]);
  near(ahead.u, 400, 1e-9, '앞 점 u');
  near(ahead.v, 300, 1e-9, '앞 점 v');
  near(ahead.d, 10, 1e-12, '앞 점 깊이');

  // 1 m 위: fovY=π/2, height 600 → fy=300, v = 300 − 300·1/10 = 270
  const up = project(view, [110, 200, 31]);
  assert.ok(up.v < 300, `위쪽 점은 v < cy: ${up.v}`);
  near(up.v, 270, 1e-9, '위쪽 점 v');
  near(up.u, 400, 1e-9, '위쪽 점 u');

  // 오른쪽 = 남쪽(−y): u = 400 + 300·1/10 = 430
  const right = project(view, [110, 199, 30]);
  assert.ok(right.u > 400, `오른쪽 점은 u > cx: ${right.u}`);
  near(right.u, 430, 1e-9, '오른쪽 점 u');
  near(right.v, 300, 1e-9, '오른쪽 점 v');

  // 래스터라이저 유니폼(GL 규약)으로 돌려도 같은 위치(dpr 1 → 장치 픽셀 = CSS 픽셀)
  const U = buildCameraUniforms(view);
  const g = projectWithUniforms(U, [110, 200, 31]);
  near(g.u, 400, 1e-9, 'GL u');
  near(g.v, 270, 1e-9, 'GL v');
});

test('K: fovY=π/2, height=600 → fy = 300', () => {
  const { view } = syncCamera({ pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: Math.PI / 2 }, SIZE, 0);
  near(view.K.fy, 300, 1e-9, 'fy');
  near(view.K.fx, 300, 1e-9, 'fx');
  // fovY=π/3, height=600 → fy = 300/tan(π/6) = 300·√3
  const b = syncCamera({ pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: Math.PI / 3 }, { width: 1001, height: 600, devicePixelRatio: 2.5 }, 0).view;
  near(b.K.fy, 519.6152422706632, 1e-9, 'fy π/3');
  assert.equal(b.K.cx, 500.5);
  assert.equal(b.devicePixelRatio, 2.5);
});

test('임의 자세 100개: R 직교·det +1, t = −R·pos, 세계→카메라→세계 왕복', () => {
  const r = rng(0x13a4);
  for (let n = 0; n < 100; n += 1) {
    const quat = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1, r() * 2 - 1].map((x) => x * (0.2 + 3 * r()));
    const pos = [(r() - 0.5) * 4000, (r() - 0.5) * 4000, (r() - 0.5) * 300];
    const { view } = syncCamera({ pos, quat, fovY: 0.2 + 2.5 * r() }, SIZE, n);
    const R = view.R;
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        let s = 0;
        for (let k = 0; k < 3; k += 1) s += R[k * 3 + i] * R[k * 3 + j];
        near(s, i === j ? 1 : 0, 1e-12, `#${n} RᵀR[${i}][${j}]`);
      }
    }
    const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    near(det, 1, 1e-12, `#${n} det`);
    for (let i = 0; i < 3; i += 1) {
      near(view.t[i], -(R[i * 3] * pos[0] + R[i * 3 + 1] * pos[1] + R[i * 3 + 2] * pos[2]), 1e-9, `#${n} t[${i}]`);
    }
    // 카메라 원점은 pos 로 되돌아온다
    const o = toWorld(view, [0, 0, 0]);
    for (let i = 0; i < 3; i += 1) near(o[i], pos[i], 1e-9, `#${n} 카메라 중심[${i}]`);
    const Xw = [pos[0] + (r() - 0.5) * 200, pos[1] + (r() - 0.5) * 200, pos[2] + (r() - 0.5) * 50];
    const back = toWorld(view, toCam(view, Xw));
    for (let i = 0; i < 3; i += 1) near(back[i], Xw[i], 1e-9, `#${n} 왕복[${i}]`);
  }
});

test('viewUpdate: client encodeMessage → server decodeMessage 왕복', () => {
  const r = rng(77);
  // float32 허용오차: pos 는 상대 2^-24·|x|(f32 반올림 상한), quat·fovY 는 절대 2e-7(|값| < 4 의 f32 반올림 오차 ≤ 1.2e-7)
  const cases = [
    [{ pos: [100, 200, 30], quat: EAST_QUAT, fovY: Math.PI / 2 }, SIZE, 0],
    [{ pos: [-1234.5, 987.25, 12.125], quat: [0.1, -0.7, 0.3, 2], fovY: 1.1 }, { width: 65535, height: 1, devicePixelRatio: 3 }, 0xffffffff],
  ];
  for (let i = 0; i < 20; i += 1) {
    cases.push([{ pos: [(r() - 0.5) * 1e4, (r() - 0.5) * 1e4, r() * 500], quat: [r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5], fovY: 0.05 + 3 * r() }, { width: 1 + Math.floor(r() * 4000), height: 1 + Math.floor(r() * 4000), devicePixelRatio: 1 + r() }, Math.floor(r() * 1e9)]);
  }
  for (const [pose, size, seq] of cases) {
    const { viewUpdate } = syncCamera(pose, size, seq);
    assert.equal(viewUpdate.type, 'VIEW_UPDATE');
    const back = serverDecode(encodeMessage(viewUpdate));
    assert.equal(back.type, 'VIEW_UPDATE');
    assert.equal(back.viewSeq, seq);
    assert.equal(back.width, size.width);
    assert.equal(back.height, size.height);
    for (let i = 0; i < 3; i += 1) near(back.pos[i], viewUpdate.pos[i], Math.abs(viewUpdate.pos[i]) * 2 ** -24 + 1e-30, `pos[${i}]`);
    for (let i = 0; i < 4; i += 1) near(back.quat[i], viewUpdate.quat[i], 2e-7, `quat[${i}]`);
    near(back.fovY, viewUpdate.fovY, 2e-7, 'fovY');
    // 값은 정확히 f32 반올림과 같다
    assert.deepEqual(back.pos, viewUpdate.pos.map(Math.fround));
    assert.deepEqual(back.quat, viewUpdate.quat.map(Math.fround));
    assert.equal(back.fovY, Math.fround(viewUpdate.fovY));
    near(Math.hypot(...viewUpdate.quat), 1, 1e-15, 'quat 단위');
  }
});

test('비단위 quat [0,0,0,2] 는 정규화되어 같은 결과', () => {
  const a = syncCamera({ pos: [1, 2, 3], quat: [0, 0, 0, 1], fovY: 1 }, SIZE, 5);
  const b = syncCamera({ pos: [1, 2, 3], quat: [0, 0, 0, 2], fovY: 1 }, SIZE, 5);
  assert.deepEqual(b.view, a.view);
  assert.deepEqual(b.viewUpdate.quat, [0, 0, 0, 1]);
  const c = syncCamera({ pos: [1, 2, 3], quat: EAST_QUAT.map((x) => x * 3.7), fovY: 1 }, SIZE, 5);
  const d = syncCamera({ pos: [1, 2, 3], quat: EAST_QUAT, fovY: 1 }, SIZE, 5);
  for (let i = 0; i < 9; i += 1) near(c.view.R[i], d.view.R[i], 1e-15, `R[${i}]`);
  for (let i = 0; i < 4; i += 1) near(c.viewUpdate.quat[i], EAST_QUAT[i], 1e-15, `quat[${i}]`);
});

test('잘못된 입력 거부', () => {
  const pose = { pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: 1 };
  const bad = (p, s, seq, E) => assert.throws(() => syncCamera(p, s, seq), E);
  bad({ ...pose, fovY: 0 }, SIZE, 0, RangeError);
  bad({ ...pose, fovY: Math.PI }, SIZE, 0, RangeError);
  bad({ ...pose, fovY: -0.5 }, SIZE, 0, RangeError);
  bad({ ...pose, fovY: NaN }, SIZE, 0, RangeError);
  bad({ ...pose, fovY: Math.PI - 1e-9 }, SIZE, 0, RangeError); // f32 반올림이 π 를 넘는다
  bad({ ...pose, fovY: '1' }, SIZE, 0, TypeError);
  bad({ ...pose, quat: [0, 0, 0, 0] }, SIZE, 0, RangeError);
  bad({ ...pose, quat: [0, 0, Infinity, 1] }, SIZE, 0, RangeError);
  bad({ ...pose, quat: [0, 0, 1] }, SIZE, 0, TypeError);
  bad({ ...pose, pos: [NaN, 0, 0] }, SIZE, 0, RangeError);
  bad({ ...pose, pos: [0, 1e39, 0] }, SIZE, 0, RangeError);
  bad({ ...pose, pos: [0, 0] }, SIZE, 0, TypeError);
  bad({ ...pose, pos: [0, '0', 0] }, SIZE, 0, TypeError);
  bad(null, SIZE, 0, TypeError);
  bad(pose, { width: 0, height: 600, devicePixelRatio: 1 }, 0, RangeError);
  bad(pose, { width: 800, height: 600.5, devicePixelRatio: 1 }, 0, RangeError);
  bad(pose, { width: 800, height: 600, devicePixelRatio: 0 }, 0, RangeError);
  bad(pose, { width: 65536, height: 600, devicePixelRatio: 1 }, 0, RangeError);
  bad(pose, null, 0, TypeError);
  bad(pose, SIZE, -1, RangeError);
  bad(pose, SIZE, 2 ** 32, RangeError);
  bad(pose, SIZE, 1.5, RangeError);
  bad(pose, SIZE, '0', TypeError);
  // 경계값은 받는다
  syncCamera({ ...pose, fovY: Math.PI - 1e-6 }, { width: 65535, height: 65535, devicePixelRatio: 1 }, 2 ** 32 - 1);
});
