import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from './index.mjs';
import * as asset from '../asset/index.mjs';
import * as points from '../points/index.mjs';
import { pieceKeyString } from '../proto/index.mjs';
import { encodeChunkKey } from '../../server/asset/ids/index.mjs';
import { project as rasterProject } from '../../server/raster_ref/project/index.mjs';
import { cameraExtrinsics } from '../../bench/baseline/ref_images/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';

// 클라이언트 래스터라이저 계약 검사(F-215).
// 형식 상수 대조, K 배율(같은 비율 축별·다른 비율 단일 배율 중앙 맞춤)·dpr 손계산, GL 변환·NDC, 그리기 규칙,
// key 형식, 서명 전체 문자열, 오류 형을 확인한다.

const { scaleIntrinsics, fitIntrinsics, drawingBufferSize, cvToGlExtrinsics, cameraPointToGl, pixelToNdc, selectDrawable, ClientRasterError } = contract;

/** contracts/raster 투영식: u = fx·x/d + cx, v = fy·y/d + cy. */
const project = (K, [x, y, d]) => [K.fx * x / d + K.cx, K.fy * y / d + K.cy];
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const assertK = (got, want) => {
  for (const n of ['fx', 'fy', 'cx', 'cy']) assert(near(got[n], want[n]), `${n}: ${got[n]} != ${want[n]}`);
};

// 기준: 원본 사진 2048×1152 에서 보정된 K(renderer_basis §1-2 와 같은 크기).
const REF_W = 2048;
const REF_H = 1152;
const K_REF = Object.freeze({ fx: 1000, fy: 1000, cx: 1024, cy: 576 });
const XC = [1, 0.5, 10]; // 카메라 좌표 점. 기준 격자 투영 (1124, 626)

test('형식 상수는 contracts/asset·contracts/points 와 같다', () => {
  assert.equal(contract.FORMAT_POINT27, 1);
  assert.equal(contract.FORMAT_GAUSS56, 2);
  assert.equal(contract.FORMAT_POINT27, asset.FORMAT_POINT27);
  assert.equal(contract.FORMAT_GAUSS56, asset.FORMAT_GAUSS56);
  assert.equal(contract.FORMAT_POINT27, points.FORMAT_POINT27);
  assert.equal(contract.FORMAT_GAUSS56, points.FORMAT_GAUSS56);
  assert.deepEqual({ ...contract.RECORD_BYTES }, { 1: 27, 2: 56 });
  assert.deepEqual({ ...contract.RECORD_BYTES }, { ...asset.SOURCE_RECORD_BYTES });
  assert.deepEqual({ ...contract.RECORD_BYTES }, { ...points.RECORD_BYTES });
  assert.equal(Object.isFrozen(contract.RECORD_BYTES), true);
  // 형식 1 만 법선 평면을 가진다(법선 의미는 형식 1 에만 적용)
  const names = (f) => asset.PLANES[f].map((p) => p.name);
  assert(names(asset.FORMAT_POINT27).includes('normal_oct_x'));
  assert(!names(asset.FORMAT_GAUSS56).some((n) => n.startsWith('normal')));
  for (const f of [asset.FORMAT_POINT27, asset.FORMAT_GAUSS56]) {
    assert.deepEqual(names(f).slice(3, 6), ['color_r', 'color_g', 'color_b']);
    assert(asset.PLANES[f].slice(3, 6).every((p) => p.type === 'u8'));
  }
});

test('근거 없는 28 B 패딩 상수는 내보내지 않는다', () => {
  assert.equal('POINT27_PADDED_BYTES' in contract, false);
  assert.equal(Object.values(contract).includes(28), false);
});

test('scaleIntrinsics: 같은 가로세로비, dpr 2 (손계산)', () => {
  // CSS 960×540, dpr 2 → 버퍼 1920×1080, sx = sy = 1920/2048 = 0.9375
  assert.deepEqual(drawingBufferSize(960, 540, 2), { width: 1920, height: 1080 });
  const K = scaleIntrinsics(K_REF, REF_W, REF_H, 960, 540, 2);
  assertK(K, { fx: 937.5, fy: 937.5, cx: 960, cy: 540 });
  const [u, v] = project(K, XC);
  assert(near(u, 1053.75) && near(v, 586.875), `${u},${v}`);
  // 반올림이 없는 배율이므로 기준 투영 (1124, 626) 을 배율로 옮긴 값과 정확히 같다(0.5 px 허용은 반올림 경우에만)
  assert.equal(u, 1124 * 0.9375);
  assert.equal(v, 626 * 0.9375);
});

test('fitIntrinsics: 가로세로비가 다르면 배율 하나로 fx/fy 를 지키고 기준 영상 중심을 버퍼 중심에 둔다(손계산)', () => {
  // CSS 375×667, dpr 3 → 버퍼 1125×2001. sx = 1125/2048 = 0.54931640625, sy = 2001/1152 = 1.73697916…
  assert.deepEqual(drawingBufferSize(375, 667, 3), { width: 1125, height: 2001 });
  const sx = 1125 / 2048;
  const sy = 2001 / 1152;
  // contain(기본): s = min = sx(가로에 맞춤). cy = 576·s + (2001 − 1152·s)/2 = 1000.5
  const Kc = fitIntrinsics(K_REF, REF_W, REF_H, 375, 667, 3);
  assert.deepEqual(Kc, fitIntrinsics(K_REF, REF_W, REF_H, 375, 667, 3, 'contain'));
  assertK(Kc, { fx: 1000 * sx, fy: 1000 * sx, cx: 562.5, cy: 1000.5 });
  assert.equal(Kc.fx, 549.31640625);
  // cover: s = max = sy(세로에 맞춤)
  const Kv = fitIntrinsics(K_REF, REF_W, REF_H, 375, 667, 3, 'cover');
  assertK(Kv, { fx: 1000 * sy, fy: 1000 * sy, cx: 562.5, cy: 1000.5 });
  // 비가 1 이 아닌 K_ref 도 fx/fy 가 1e-9 안에서 유지되고, 기준 영상 중심 (1024, 576) 의 광선이 버퍼 중심으로 간다
  const Kr = Object.freeze({ fx: 1000, fy: 1100, cx: 1010, cy: 590 });
  const centreRay = [(1024 - Kr.cx) / Kr.fx, (576 - Kr.cy) / Kr.fy, 1];
  for (const mode of ['contain', 'cover']) {
    const K = fitIntrinsics(Kr, REF_W, REF_H, 375, 667, 3, mode);
    assert(near(K.fx / K.fy, Kr.fx / Kr.fy, 1e-9), `${mode} fx/fy ${K.fx / K.fy}`);
    const [u, v] = project(K, centreRay);
    assert(near(u, 1125 / 2) && near(v, 2001 / 2), `${mode} 중심 ${u},${v}`);
  }
  // 축별 scaleIntrinsics 를 여기 쓰면 장면이 늘어난다: fy/fx = sy/sx ≈ 3.16 (그래서 같은 비율에만 쓴다)
  const stretched = scaleIntrinsics(K_REF, REF_W, REF_H, 375, 667, 3);
  assert(near(stretched.fy / stretched.fx, sy / sx, 1e-12));
  assert(stretched.fy / stretched.fx > 3.16 && stretched.fy / stretched.fx < 3.17);
});

test('fitIntrinsics: 가로세로비가 같으면 scaleIntrinsics 와 같다(두 mode 모두)', () => {
  // 960×540@2 → 1920×1080, 1024×576@1.5 → 1536×864: 둘 다 16:9 로 sx = sy
  for (const [W, H, dpr] of [[960, 540, 2], [1024, 576, 1.5], [2048, 1152, 1]]) {
    const want = scaleIntrinsics(K_REF, REF_W, REF_H, W, H, dpr);
    for (const mode of ['contain', 'cover']) assert.deepEqual(fitIntrinsics(K_REF, REF_W, REF_H, W, H, dpr, mode), want, `${W}×${H}@${dpr} ${mode}`);
  }
  assertK(fitIntrinsics(K_REF, REF_W, REF_H, 960, 540, 2), { fx: 937.5, fy: 937.5, cx: 960, cy: 540 });
});

test('scaleIntrinsics: dpr 은 한 번만 적용되고 단계를 나눠도 결과가 같다', () => {
  // CSS 960×540·dpr 2 와 CSS 1920×1080·dpr 1 은 같은 장치 격자다
  assert.deepEqual(scaleIntrinsics(K_REF, REF_W, REF_H, 960, 540, 2), scaleIntrinsics(K_REF, REF_W, REF_H, 1920, 1080, 1));
  // 원본 → CSS(dpr 1) → 장치(dpr) 두 단계 = 원본 → 장치 한 단계
  // 같은 비율: scaleIntrinsics 두 단계 = 한 단계(반올림 없는 dpr)
  for (const [W, H, dpr] of [[960, 540, 2], [1024, 576, 1.5]]) {
    const css = scaleIntrinsics(K_REF, REF_W, REF_H, W, H, 1);
    const two = scaleIntrinsics(css, W, H, W, H, dpr);
    const one = scaleIntrinsics(K_REF, REF_W, REF_H, W, H, dpr);
    for (const n of ['fx', 'fy', 'cx', 'cy']) assert(near(two[n], one[n], 1e-9), `${W}×${H}@${dpr} ${n}`);
  }
  // 다른 비율: 호출자 fitIntrinsics(…, 1) → 렌더러 scaleIntrinsics(dpr) = fitIntrinsics(…, dpr) (반올림 없는 dpr)
  for (const [W, H, dpr] of [[800, 600, 1.5], [375, 667, 3]]) {
    for (const mode of ['contain', 'cover']) {
      const css = fitIntrinsics(K_REF, REF_W, REF_H, W, H, 1, mode);
      const two = scaleIntrinsics(css, W, H, W, H, dpr);
      const one = fitIntrinsics(K_REF, REF_W, REF_H, W, H, dpr, mode);
      for (const n of ['fx', 'fy', 'cx', 'cy']) assert(near(two[n], one[n], 1e-9), `${W}×${H}@${dpr} ${mode} ${n}`);
    }
  }
});

test('scaleIntrinsics: 버퍼 반올림이 있는 dpr 에서 CSS 위치 차이 ≤ 0.5 장치 픽셀(손계산)', () => {
  // CSS 333×222, dpr 1.25 → 416.25×277.5 → 버퍼 416×278
  assert.deepEqual(drawingBufferSize(333, 222, 1.25), { width: 416, height: 278 });
  // 가로 쪽 반올림도 고정: 333·1.5 = 499.5 → 500, 223·1.5 = 334.5 → 335, 333·1.7 = 566.1 → 566
  assert.deepEqual(drawingBufferSize(333, 223, 1.5), { width: 500, height: 335 });
  assert.deepEqual(drawingBufferSize(333, 223, 1.7), { width: 566, height: 379 });
  // CSS K 는 호출자가 fitIntrinsics(contain) 로 만든다: s = 333/2048, fx = fy = 162.59765625, 중심 (166.5, 111)
  const Kc = fitIntrinsics(K_REF, REF_W, REF_H, 333, 222, 1);
  assertK(Kc, { fx: 162.59765625, fy: 162.59765625, cx: 166.5, cy: 111 });
  // 렌더러가 dpr 을 적용: sx = 416/333, sy = 278/222 (반올림 때문에 아주 조금 다르다)
  const Kd = scaleIntrinsics(Kc, 333, 222, 333, 222, 1.25);
  assertK(Kd, { fx: 203.125, fy: 1000 * 278 * 1.5 / 2048, cx: 208, cy: 139 });
  // 안쪽 점: 장치 (228.3125, 149.1806…) 대 CSS×dpr (228.4497…, 148.9123…) → 차이 0.137, 0.268
  const [ud, vd] = project(Kd, XC);
  const [uc, vc] = project(Kc, XC);
  assert(near(ud, 228.3125) && near(vd, 149.1806640625));
  assert(near(uc, 182.759765625) && near(vc, 119.1298828125));
  assert(Math.abs(ud - uc * 1.25) <= 0.5 && Math.abs(vd - vc * 1.25) <= 0.5);
  // 반올림이 실제로 차이를 만든다(정확히 같지 않다)
  assert.notEqual(ud, uc * 1.25);
  assert.notEqual(vd, vc * 1.25);
  // 오른쪽·아래 끝 점(CSS 모서리 (333, 222)): 장치 (416, 278) 대 CSS×dpr (416.25, 277.5) → 0.25, 0.5 (상한에 닿음)
  const edge = [1.024, 111 / 162.59765625, 1];
  const [ue, ve] = project(Kd, edge);
  const [uce, vce] = project(Kc, edge);
  assert(near(ue, 416) && near(ve, 278));
  assert(near(uce * 1.25, 416.25) && near(vce * 1.25, 277.5));
  assert(Math.abs(ue - uce * 1.25) <= 0.5 + 1e-9 && Math.abs(ve - vce * 1.25) <= 0.5 + 1e-9);
});

test('버퍼 반올림: 333×222@1.25 에서 cy 는 138.75 가 아니라 139 이고 버퍼는 416×278 이다', () => {
  // 반올림 없는 sy 는 (222·1.25)/222 = 1.25 이고 cy = 111·1.25 = 138.75 다. 실제 sy 는 round(277.5)/222 = 278/222 이므로
  // cy = 111·278/222 = 139. 같은 값을 위 시험은 assertK(허용 오차 1e-9)로, 여기는 정확히 같음(===)으로 고정한다.
  const Kc = fitIntrinsics(K_REF, REF_W, REF_H, 333, 222, 1);
  assert.equal(Kc.cy, 111);
  const Kd = scaleIntrinsics(Kc, 333, 222, 333, 222, 1.25);
  assert.equal(Kd.cy, 139);
  assert.notEqual(Kd.cy, Kc.cy * 1.25);
  assert.deepEqual(drawingBufferSize(333, 222, 1.25), { width: 416, height: 278 });
});

test('fitIntrinsics: sx > sy 화면(가로 화면 844×390@3)에서 contain·cover 손계산', () => {
  // 버퍼 = 2532×1170. sx = 2532/2048 = 1.236328125, sy = 1170/1152 = 1.015625 (sx > sy)
  // contain: s = min = sy = 1.015625 (세로 맞춤)
  //   fx = fy = 1000·1.015625 = 1015.625
  //   cx = 1024·1.015625 + (2532 − 2048·1.015625)/2 = 1040 + (2532 − 2080)/2 = 1040 + 226 = 1266
  //   cy = 576·1.015625 + (1170 − 1152·1.015625)/2 = 585 + 0 = 585
  // cover: s = max = sx = 1.236328125 (가로 맞춤)
  //   fx = fy = 1236.328125
  //   cx = 1024·1.236328125 + (2532 − 2048·1.236328125)/2 = 1266 + 0 = 1266
  //   cy = 576·1.236328125 + (1170 − 1152·1.236328125)/2 = 712.125 + (1170 − 1424.25)/2 = 712.125 − 127.125 = 585
  assert.deepEqual(drawingBufferSize(844, 390, 3), { width: 2532, height: 1170 });
  const Kc = fitIntrinsics(K_REF, REF_W, REF_H, 844, 390, 3, 'contain');
  assert.deepEqual(Kc, { fx: 1015.625, fy: 1015.625, cx: 1266, cy: 585 });
  assert.deepEqual(fitIntrinsics(K_REF, REF_W, REF_H, 844, 390, 3), Kc);
  const Kv = fitIntrinsics(K_REF, REF_W, REF_H, 844, 390, 3, 'cover');
  assert.deepEqual(Kv, { fx: 1236.328125, fy: 1236.328125, cx: 1266, cy: 585 });
});

test('scaleIntrinsics: 픽셀 규약은 contracts/raster 와 같다(정수 = 칸 모서리, 중심 u=i+0.5, cx·sx)', () => {
  const K = scaleIntrinsics(K_REF, REF_W, REF_H, 960, 540, 2);
  // 영상 중심(기준 cx = 2048/2)은 버퍼 중심 1920/2 로 간다. 칸 중심 규약('half')이면 959.96875 가 된다
  assert.equal(K.cx, 960);
  assert.notEqual(K.cx, (1024 + 0.5) * 0.9375 - 0.5);
  // 기준 픽셀 1123 의 중심 1123.5 는 장치 좌표 1053.28125 → 칸 floor = 1053
  assert.equal(Math.floor(1123.5 * 0.9375), 1053);
  const [u] = project(K, XC);
  assert.equal(Math.floor(u), 1053);
});

test('scaleIntrinsics·drawingBufferSize 는 잘못된 입력을 ClientRasterError(view)로 거부한다', () => {
  const bad = [
    () => scaleIntrinsics(null, REF_W, REF_H, 960, 540, 1),
    () => scaleIntrinsics({ ...K_REF, fx: 0 }, REF_W, REF_H, 960, 540, 1),
    () => scaleIntrinsics({ ...K_REF, cy: NaN }, REF_W, REF_H, 960, 540, 1),
    () => scaleIntrinsics(K_REF, 0, REF_H, 960, 540, 1),
    () => scaleIntrinsics(K_REF, REF_W, REF_H, 960.5, 540, 1),
    () => scaleIntrinsics(K_REF, REF_W, REF_H, 960, 540, 0),
    () => scaleIntrinsics(K_REF, REF_W, REF_H, 960, 540, Infinity),
    () => drawingBufferSize(1, 1, 0.1),
    () => drawingBufferSize(1920, 1080, 1e300),
    () => drawingBufferSize(1e10, 1e10, 1e300),
    () => drawingBufferSize(3000, 2000, 1e6),
    () => drawingBufferSize(2 ** 53, 1, 1),
    () => drawingBufferSize(1920, 1080, 2, { maxDimension: 2000 }),
    () => fitIntrinsics(K_REF, REF_W, REF_H, 375, 667, 3, 'stretch'),
    () => fitIntrinsics({ ...K_REF, fy: -1 }, REF_W, REF_H, 375, 667, 3),
    () => fitIntrinsics(K_REF, REF_W, 0, 375, 667, 3),
    () => pixelToNdc(0, 0, 0, 10),
    () => pixelToNdc(NaN, 0, 10, 10),
    () => cameraPointToGl([1, 2]),
    () => cameraPointToGl([1, 2, NaN]),
    () => cvToGlExtrinsics([1, 0, 0], [0, 0, 0]),
  ];
  for (const f of bad) {
    assert.throws(f, (e) => e instanceof ClientRasterError && e.code === 'view' && /^client_raster: view: /.test(e.message));
  }
  // 입력 K 를 바꾸지 않는다(순수)
  const K = { ...K_REF };
  scaleIntrinsics(K, REF_W, REF_H, 800, 600, 1.5);
  fitIntrinsics(K, REF_W, REF_H, 375, 667, 3, 'cover');
  assert.deepEqual(K, K_REF);
});

test('drawingBufferSize: 상한 안의 값은 통과하고 maxDimension 은 주입할 수 있다', () => {
  assert.deepEqual(drawingBufferSize(1920, 1080, 2), { width: 3840, height: 2160 });
  assert.deepEqual(drawingBufferSize(16384, 1, 1), { width: 16384, height: 1 });
  assert.throws(() => drawingBufferSize(16385, 1, 1), (e) => e instanceof ClientRasterError && e.code === 'view');
  assert.deepEqual(drawingBufferSize(1920, 1080, 2, { maxDimension: 4000 }), { width: 3840, height: 2160 });
});

test('GL 변환 diag(1,-1,-1): 외부 파라미터·점, 카메라 뒤 점은 버린다', () => {
  // tools/render_views 는 GL → OpenCV 를 diag 로 바꾼다. 여기 cvToGlExtrinsics 는 그 역이며 diag 는 자기 역행렬이다
  const vp = { eye: [3, -4, 2], target: [0, 1, 0.5], up: [0, 0, 1], width: 64, height: 48, fov_y_deg: 60 };
  const cv = viewpointToCamera(vp);
  const gl = cameraExtrinsics({ eye: vp.eye, target: vp.target, up: vp.up });
  const back = cvToGlExtrinsics(cv.R, cv.t);
  for (let i = 0; i < 9; i += 1) assert(near(back.R[i], gl.R[i], 1e-12), `R[${i}]`);
  for (let i = 0; i < 3; i += 1) assert(near(back.t[i], gl.t[i], 1e-12), `t[${i}]`);
  const twice = cvToGlExtrinsics(back.R, back.t);
  for (let i = 0; i < 9; i += 1) assert(near(twice.R[i], cv.R[i], 0), `twice R[${i}]`);
  for (let i = 0; i < 3; i += 1) assert(near(twice.t[i], cv.t[i], 0), `twice t[${i}]`);
  // 점: X_gl = diag·X_c
  assert.deepEqual(cameraPointToGl([1, 0.5, 10]), [1, -0.5, -10]);
  // 카메라 뒤(d < 0)·카메라 평면(d = 0)·투영이 무한한 점은 버린다. contracts/raster project 가 NaN 을 내는 조건과 같다
  const idCam = { width: 64, height: 48, K: { fx: 50, fy: 50, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  for (const xc of [[1, 0.5, -2], [1, 0.5, 0], [0, 0, -0], [1, 0.5, 1e-320]]) {
    assert.equal(cameraPointToGl(xc), null, String(xc));
    const p = rasterProject(idCam, xc);
    assert(Number.isNaN(p.u) && Number.isNaN(p.v), `raster ${xc}`);
  }
  // 앞에 있는 점은 둘 다 받는다
  for (const xc of [[1, 0.5, 10], [0, 0, 1e-3]]) {
    assert.notEqual(cameraPointToGl(xc), null);
    assert(Number.isFinite(rasterProject(idCam, xc).u));
  }
});

test('pixelToNdc: (0,0) → (-1,1), y 뒤집힘, 칸 중심 u=i+0.5 는 contracts/raster 와 같은 칸', () => {
  assert.deepEqual(pixelToNdc(0, 0, 1920, 1080), [-1, 1]);
  assert.deepEqual(pixelToNdc(1920, 1080, 1920, 1080), [1, -1]);
  assert.deepEqual(pixelToNdc(960, 540, 1920, 1080), [0, 0]);
  // 4×2 버퍼: 칸 (0,0) 중심 (0.5, 0.5) → (-0.75, 0.5), 칸 (3,1) 중심 (3.5, 1.5) → (0.75, -0.5) (GL 의 gl_FragCoord = i+0.5)
  assert.deepEqual(pixelToNdc(0.5, 0.5, 4, 2), [-0.75, 0.5]);
  assert.deepEqual(pixelToNdc(3.5, 1.5, 4, 2), [0.75, -0.5]);
  // 투영 → NDC 를 GL 좌표에서 GL 투영 행렬(K 로 만든 것)로 계산한 값과 비교한다
  const K = fitIntrinsics(K_REF, REF_W, REF_H, 375, 667, 3);
  const bw = 1125;
  const bh = 2001;
  for (const xc of [XC, [-2, 3, 7], [0.1, -0.4, 2]]) {
    const [u, v] = project(K, xc);
    const [nx, ny] = pixelToNdc(u, v, bw, bh);
    const [xg, yg, zg] = cameraPointToGl(xc);
    const w = -zg;
    const gx = (2 * K.fx / bw) * (xg / w) + (2 * K.cx / bw - 1);
    const gy = (2 * K.fy / bh) * (yg / w) + (1 - 2 * K.cy / bh);
    assert(near(nx, gx, 1e-12) && near(ny, gy, 1e-12), `${xc}`);
    // 같은 점이 래스터 칸 (floor u, floor v) 에 들고, 그 칸 중심의 NDC 와 반 칸(1/bw, 1/bh) 이내다
    const [cxn, cyn] = pixelToNdc(Math.floor(u) + 0.5, Math.floor(v) + 0.5, bw, bh);
    assert(Math.abs(nx - cxn) <= 1 / bw && Math.abs(ny - cyn) <= 1 / bh);
  }
});

test('selectDrawable: LEVEL_ARRIVED 없는 조각은 그리지 않고, 높은 수준이 오면 낮은 수준은 버린다(쌓지 않음)', () => {
  const k = (seg, level, chunk = 0) => `${seg}.${level}.0.0.0.${chunk}`;
  const keys = [k(7, 0), k(7, 0, 1), k(7, 1), k(7, 2), k(9, 1)];
  // 아무 수준도 도착하지 않음: 모두 대기, 그리는 것 없음
  assert.deepEqual(selectDrawable(keys, []), { draw: [], pending: keys, discard: [] });
  // 7 의 수준 0 도착: 수준 0 만 그림, 1·2 는 자기 LEVEL_ARRIVED 대기
  const A = (segmentId, level, ...ks) => ({ segmentId, level, keys: ks });
  assert.deepEqual(selectDrawable(keys, [A(7, 0, k(7, 0), k(7, 0, 1))]), {
    draw: [k(7, 0), k(7, 0, 1)], pending: [k(7, 1), k(7, 2), k(9, 1)], discard: [],
  });
  // 7 의 수준 1 도착: 수준 0 은 바뀌어 버림(쌓지 않음), 수준 1 만 그림
  assert.deepEqual(selectDrawable(keys, [A(7, 0, k(7, 0), k(7, 0, 1)), A(7, 1, k(7, 1))]), {
    draw: [k(7, 1)], pending: [k(7, 2), k(9, 1)], discard: [k(7, 0), k(7, 0, 1)],
  });
  // 7 의 수준 2 가 1 없이 도착: LEVEL_ARRIVED 를 못 받은 수준 1 조각도 그리지 않고 버린다. 구간 9 는 따로다
  const arrived = [A(7, 2, k(7, 2)), A(7, 0, k(7, 0), k(7, 0, 1)), A(9, 1, k(9, 1))];
  const want = { draw: [k(7, 2), k(9, 1)], pending: [], discard: [k(7, 0), k(7, 0, 1), k(7, 1)] };
  assert.deepEqual(selectDrawable(keys, arrived), want);
  // 도착 순서와 무관
  assert.deepEqual(selectDrawable(keys, [...arrived].reverse()), want);
  // 수준 3 조각은 아직 대기
  assert.deepEqual(selectDrawable([k(7, 3)], arrived), { draw: [], pending: [k(7, 3)], discard: [] });
  // segmentId 상한(2^30 배타): 2^30 − 1 은 받는다
  assert.deepEqual(selectDrawable([`${2 ** 30 - 1}.0.0.0.0.0`], [{ segmentId: 2 ** 30 - 1, level: 0, keys: [`${2 ** 30 - 1}.0.0.0.0.0`] }]).draw, [`${2 ** 30 - 1}.0.0.0.0.0`]);
  // i32 끝값과 chunkIndex 65535 는 받는다(손계산: 2^31 − 1 = 2147483647)
  const edge = '7.0.2147483647.-2147483648.0.65535';
  assert.deepEqual(selectDrawable([edge], [A(7, 0, edge)]).draw, [edge]);
  // 잘못된 입력은 ClientRasterError(piece)
  for (const f of [
    () => selectDrawable('7.0.0.0.0.0', []),
    () => selectDrawable(['7:0:0:0:0:0'], []),
    () => selectDrawable([], [{ segmentId: 7, level: 4 }]),
    () => selectDrawable([], [{ segmentId: -1, level: 0 }]),
    () => selectDrawable([], [{ segmentId: 2 ** 30, level: 0 }]),
    () => selectDrawable([], [{ segmentId: 2 ** 53, level: 0 }]),
    () => selectDrawable(['1073741824.1.0.0.0.0'], []),
    () => selectDrawable([`${2 ** 30}.0.0.0.0.0`], [{ segmentId: 7, level: 0, keys: ['7.0.0.0.0.0'] }]),
    () => selectDrawable(['7.0.100000000000000000000.0.0.0'], []),
    () => selectDrawable(['7.0.0.-2147483649.0.0'], []),
    () => selectDrawable(['7.0.2147483648.0.0.0'], []),
    () => selectDrawable(['7.0.0.0.0.65536'], []),
    () => selectDrawable([], [{ segmentId: 7, level: 0, keys: ['1073741824.0.0.0.0.0'] }]),
    () => selectDrawable([], [{ segmentId: 7, level: 0, keys: ['8.0.0.0.0.0'] }]),
    () => selectDrawable([], [{ segmentId: 7, level: 0, keys: ['7.1.0.0.0.0'] }]),
    () => selectDrawable([], [{ segmentId: 7, level: 0, keys: 'x' }]),
    () => selectDrawable([], null),
  ]) assert.throws(f, (e) => e instanceof ClientRasterError && e.code === 'piece');
});

test('selectDrawable(F-227): 완료 key 집합 밖의 같은 수준 key 는 그리지 않고 discard 로 해제된다', () => {
  const k0 = '9.1.0.0.0.0';
  const k1 = '9.1.0.0.0.1';
  // 두 번째 key 가 시도 중간에 abandoned: 완료 집합은 첫 번째뿐
  assert.deepEqual(selectDrawable([k0, k1], [{ segmentId: 9, level: 1, keys: [k0] }]), { draw: [k0], pending: [], discard: [k1] });
  // keys 가 없거나 빈 배열인 항목은 거부한다(LEVEL_ARRIVED pieceCount ≥ 1, F-230)
  for (const a of [{ segmentId: 9, level: 1 }, { segmentId: 9, level: 1, keys: [] }]) {
    assert.throws(() => selectDrawable([k0, k1], [a]), (e) => e instanceof ClientRasterError && e.code === 'piece', JSON.stringify(a));
  }
  // 같은 수준 항목이 둘이면 완료 집합은 합집합, 낮은 수준 항목의 집합은 쓰이지 않는다
  const low = '9.0.0.0.0.0';
  assert.deepEqual(
    selectDrawable([low, k0, k1], [{ segmentId: 9, level: 1, keys: [k0] }, { segmentId: 9, level: 0, keys: [low] }, { segmentId: 9, level: 1, keys: [k1] }]),
    { draw: [k0, k1], pending: [], discard: [low] },
  );
  // 더 높은 수준이 도착하면 낮은 수준의 집합은 버려진다
  const k2 = '9.2.0.0.0.0';
  assert.deepEqual(selectDrawable([k0, k2], [{ segmentId: 9, level: 1, keys: [k0] }, { segmentId: 9, level: 2, keys: [k2] }]), { draw: [k2], pending: [], discard: [k0] });
  // 다른 구간의 집합은 영향이 없다
  assert.deepEqual(selectDrawable(['8.1.0.0.0.0', k1], [{ segmentId: 9, level: 1, keys: [k0] }]), { draw: [], pending: ['8.1.0.0.0.0'], discard: [k1] });
});

test('maxDimension: 상한 32768, options=null 허용, 잘못된 options 는 거부(F-229 ⑥)', () => {
  assert.deepEqual(drawingBufferSize(20000, 1, 1, { maxDimension: 32768 }), { width: 20000, height: 1 });
  assert.throws(() => drawingBufferSize(1, 1, 1, { maxDimension: 32769 }), (e) => e instanceof ClientRasterError && e.code === 'view');
  assert.throws(() => drawingBufferSize(1, 1, 1, { maxDimension: 1e300 }), (e) => e instanceof ClientRasterError && e.code === 'view');
  assert.deepEqual(drawingBufferSize(1920, 1080, 2, null), { width: 3840, height: 2160 });
  assert.deepEqual(drawingBufferSize(1920, 1080, 2, undefined), { width: 3840, height: 2160 });
  assert.deepEqual(drawingBufferSize(1920, 1080, 2, {}), { width: 3840, height: 2160 });
  assert.throws(() => drawingBufferSize(1, 1, 1, 5), (e) => e instanceof ClientRasterError && e.code === 'view');
});

test('배율 범위 [1/4096, 4096]: 범위 밖 sx·sy 는 ClientRasterError(view)(F-229 ⑥)', () => {
  const K1 = { fx: 1, fy: 1, cx: 0, cy: 0 };
  // 경계는 정확히 표현되는 값: 4096/1, 1/4096
  assert.deepEqual(scaleIntrinsics(K1, 1, 1, 4096, 1, 1), { fx: 4096, fy: 1, cx: 0, cy: 0 });
  assert.deepEqual(scaleIntrinsics(K1, 4096, 1, 1, 1, 1), { fx: 1 / 4096, fy: 1, cx: 0, cy: 0 });
  const bad = [
    () => scaleIntrinsics(K1, 1, 1, 4097, 1, 1),
    () => scaleIntrinsics(K1, 4097, 1, 1, 1, 1),
    () => scaleIntrinsics(K1, 1e-300, 1152, 960, 540, 2),
    () => fitIntrinsics(K_REF, 1e-300, REF_H, 375, 667, 3, 'cover'),
    () => fitIntrinsics(K_REF, 1e-300, REF_H, 375, 667, 3, 'contain'),
    () => fitIntrinsics(K_REF, REF_W, 1e300, 375, 667, 3),
    () => fitIntrinsics(K1, 1, 1, 4097, 1, 1),
  ];
  for (const f of bad) assert.throws(f, (e) => e instanceof ClientRasterError && e.code === 'view');
  // 범위 안 contain·cover 는 그대로: refW = 1, W = 4096 → sx = 4096, sy = 1 → contain s = 1, cover s = 4096
  assert.deepEqual(fitIntrinsics(K1, 1, 1, 4096, 1, 1, 'contain'), { fx: 1, fy: 1, cx: 2047.5, cy: 0 });
  assert.deepEqual(fitIntrinsics(K1, 1, 1, 4096, 1, 1, 'cover'), { fx: 4096, fy: 4096, cx: 0 + (4096 - 4096) / 2, cy: (1 - 4096) / 2 });
});

test('key 는 ASSET_FORMAT §11 정규 문자열(server/asset/ids encodeChunkKey)이고 proto 의 a:b 형식이 아니다', () => {
  const golden = [
    [{ segmentId: 7, level: 2, tileX: 1, tileY: -2, lod: 0, chunkIndex: 0 }, '7.2.1.-2.0.0'],
    [{ segmentId: 7, level: 3, tileX: 0, tileY: 0, lod: 1, chunkIndex: 2 }, '7.3.0.0.1.2'],
  ];
  for (const [k, s] of golden) {
    assert.equal(encodeChunkKey(k), s);
    assert.match(s, contract.PIECE_KEY_PATTERN);
    assert.doesNotMatch(pieceKeyString(k), contract.PIECE_KEY_PATTERN);
  }
  for (const s of ['07.2.1.-2.0.0', '7.2.1.-0.0.0', '7.4.0.0.0.0', '7.2.0.0.8.0', '7:2:0:0:0:0', '7.2.0.0.0', '']) {
    assert.doesNotMatch(s, contract.PIECE_KEY_PATTERN, s);
  }
});

test('createRenderer 는 ClientRasterError(unimplemented)를 던진다', () => {
  assert.throws(
    () => contract.createRenderer({}),
    (e) => e instanceof ClientRasterError && e.code === 'unimplemented' && e.name === 'ClientRasterError' && /^client_raster: unimplemented: /.test(e.message),
  );
});

test('ClientRasterError 는 code 와 client_raster: 접두를 가진다', () => {
  const err = new ClientRasterError('piece', 'bad');
  assert(err instanceof Error);
  assert.equal(err.name, 'ClientRasterError');
  assert.equal(err.code, 'piece');
  assert.equal(err.message, 'client_raster: piece: bad');
});

test('CLIENT_RASTER_API 서명은 문자열 전체가 기대값과 같다(순서 포함)', () => {
  const expected = {
    createRenderer: 'createRenderer(options) -> Renderer  options: {canvas, maxPieceBytes, maxResidentBytes}',
    uploadPiece: 'renderer.uploadPiece(key, bytes) -> Promise<void>  key: ASSET_FORMAT §11 "seg.level.tileX.tileY.lod.chunk", bytes: .skla piece (format 1|2)',
    releasePiece: 'renderer.releasePiece(key) -> void  basis: selectDrawable discard + pending cleanup only (no direct wiring of server adapter release notices); must tolerate repeated release of the same key',
    setView: 'renderer.setView(view) -> void  view: {R, t, K, width, height, devicePixelRatio}  K·width·height in CSS px',
    draw: 'renderer.draw() -> FrameStats  {drawnPoints, drawnPieces, droppedFrames, drawMs}',
    memoryBytes: 'renderer.memoryBytes() -> number',
    dispose: 'renderer.dispose() -> void',
    onContextLost: 'renderer.onContextLost(callback?) -> void',
    onContextRestored: 'renderer.onContextRestored(callback?) -> void',
    drawingBufferSize: 'drawingBufferSize(width, height, dpr) -> {width, height}  = round(width·dpr), round(height·dpr)',
    scaleIntrinsics: 'scaleIntrinsics(K, refW, refH, W, H, dpr) -> Intrinsics  sx = round(W·dpr)/refW, sy = round(H·dpr)/refH  (same aspect / dpr step only)',
    fitIntrinsics: "fitIntrinsics(K, refW, refH, W, H, dpr, mode?) -> Intrinsics  s = min|max(sx, sy) ('contain' default | 'cover'), fx·fy·s, centred",
    cvToGlExtrinsics: 'cvToGlExtrinsics(R, t) -> {R, t}  diag(1,-1,-1)·R, diag(1,-1,-1)·t',
    cameraPointToGl: 'cameraPointToGl(xc) -> [x, -y, -z] | null  null when d = xc[2] <= 0 or not finite',
    pixelToNdc: 'pixelToNdc(u, v, bw, bh) -> [2u/bw - 1, 1 - 2v/bh]',
    selectDrawable: 'selectDrawable(keys, arrived) -> {draw, pending, discard}  arrived: [{segmentId, level, keys}] built by arrival.mjs completedKeys(PIECE list, LEVEL_ARRIVED) (keys = completed key set, non-empty)',
  };
  assert.equal(Object.isFrozen(contract.CLIENT_RASTER_API), true);
  assert.deepEqual(Object.keys(contract.CLIENT_RASTER_API), Object.keys(expected));
  for (const [name, fn] of Object.entries(expected)) {
    assert.deepEqual(Object.keys(contract.CLIENT_RASTER_API[name]), ['fn'], name);
    assert.equal(contract.CLIENT_RASTER_API[name].fn, fn, name);
  }
  // 내보낸 함수 이름과 표가 맞는다
  for (const name of ['createRenderer', 'drawingBufferSize', 'scaleIntrinsics', 'fitIntrinsics', 'cvToGlExtrinsics', 'cameraPointToGl', 'pixelToNdc', 'selectDrawable']) assert.equal(typeof contract[name], 'function', name);
});
