// 카메라·K 환산(T12.4). setView(view) 입력을 셰이더 유니폼 값으로 바꾼다. 순수 JS, Math 만 사용.
// 규약은 contracts/client_raster/index.mjs 머리 주석 ② 가 정본이다.
//   X_c = R·X_w + t (OpenCV: x 오른쪽, y 아래, z 앞, ENU 1 unit = 1 m)
//   view.K 는 width×height CSS 픽셀 격자의 값이다. dpr 은 여기서 한 곳, scaleIntrinsics 에서만 적용한다
//     (같은 격자를 장치 픽셀로 다시 표본화하는 (가)의 경우라 가로세로비가 같다).
//   가로세로비가 다른 기준 격자(예: 원본 사진 2048×1152)의 K_ref 는 cssViewIntrinsics 로 fitIntrinsics(…, dpr = 1, mode) 를
//     거쳐 CSS 픽셀 K 로 바꾼 뒤 view.K 로 넘긴다((나)의 경우). 다른 가로세로비에 scaleIntrinsics 를 쓰지 않는다(장면이 늘어남).
//   GL 규약: R_gl = diag(1,−1,−1)·R, t_gl = diag(1,−1,−1)·t, 장치 픽셀 → NDC 는 pixelToNdc.
import {
  ClientRasterError,
  drawingBufferSize,
  scaleIntrinsics,
  fitIntrinsics,
  cvToGlExtrinsics,
  pixelToNdc,
} from '../../../contracts/client_raster/index.mjs';

// 회전 검사 허용치(contracts/raster assertCamera 와 같은 1e-6)
const ROT_TOL = 1e-6;

function checkRotation(R) {
  // 정규직교: R·Rᵀ = I, det = +1
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let s = 0;
      for (let k = 0; k < 3; k += 1) s += R[i * 3 + k] * R[j * 3 + k];
      if (!(Math.abs(s - (i === j ? 1 : 0)) <= ROT_TOL)) throw new ClientRasterError('view', 'R 이 정규직교가 아님');
    }
  }
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  if (!(Math.abs(det - 1) <= ROT_TOL)) throw new ClientRasterError('view', `R 의 행렬식이 +1 이 아님: ${det}`);
}

/**
 * setView 의 view 를 셰이더 유니폼 값으로 바꾼다. 순수 함수. 검증 실패는 ClientRasterError('view').
 *   bw×bh = drawingBufferSize(width, height, dpr)                       장치 픽셀 그리기 버퍼
 *   {fx, fy, cx, cy} = scaleIntrinsics(view.K, width, height, width, height, dpr)  장치 픽셀 K
 *   {Rgl, tgl} = cvToGlExtrinsics(view.R, view.t)                        GL 카메라(y 위, −z 를 봄)
 * 셰이더 식(projectWithUniforms 와 같다): X_gl = Rgl·X_w + tgl, d = −X_gl.z,
 *   u = fx·X_gl.x/d + cx, v = −fy·X_gl.y/d + cy, NDC = (2u/bw − 1, 1 − 2v/bh)
 * @param {import('../../../contracts/client_raster/index.mjs').View} view
 * @returns {{Rgl: number[], tgl: number[], fx: number, fy: number, cx: number, cy: number, bw: number, bh: number}}
 */
export function buildCameraUniforms(view) {
  if (view === null || typeof view !== 'object') throw new ClientRasterError('view', 'view 가 객체가 아님');
  const { R, t, K, width, height, devicePixelRatio } = view;
  // R·t 의 길이·유한성은 cvToGlExtrinsics 가 'view' 로 검사한다. 회전성은 여기서 본다.
  const gl = cvToGlExtrinsics(R, t);
  checkRotation(R);
  const buf = drawingBufferSize(width, height, devicePixelRatio);
  const Kd = scaleIntrinsics(K, width, height, width, height, devicePixelRatio);
  return {
    Rgl: gl.R,
    tgl: gl.t,
    fx: Kd.fx,
    fy: Kd.fy,
    cx: Kd.cx,
    cy: Kd.cy,
    bw: buf.width,
    bh: buf.height,
  };
}

/**
 * 기준 격자 refW×refH 의 K_ref 를 width×height CSS 픽셀 화면의 view.K 로 옮긴다(가로세로비가 다를 수 있음).
 * 계약의 dpr 규칙대로 fitIntrinsics 에 dpr = 1 을 넘긴다(dpr 은 buildCameraUniforms 의 scaleIntrinsics 에서만 적용).
 * @param {import('../../../contracts/client_raster/index.mjs').Intrinsics} Kref
 * @param {number} refW
 * @param {number} refH
 * @param {number} width CSS 픽셀
 * @param {number} height CSS 픽셀
 * @param {'contain'|'cover'} [mode='contain']
 */
export function cssViewIntrinsics(Kref, refW, refH, width, height, mode = 'contain') {
  return fitIntrinsics(Kref, refW, refH, width, height, 1, mode);
}

/**
 * 유니폼으로 세계 점 하나를 셰이더와 같은 식으로 투영한다(시험·디버그용 참조 구현).
 * 카메라 뒤(d ≤ 0)이거나 결과가 유한하지 않으면 null.
 * @param {ReturnType<typeof buildCameraUniforms>} U
 * @param {number[]} Xw 세계 점 [e, n, u] m
 * @returns {{u: number, v: number, ndc: number[], d: number} | null} u·v 는 장치 픽셀
 */
export function projectWithUniforms(U, Xw) {
  const { Rgl: R, tgl: t } = U;
  const x = R[0] * Xw[0] + R[1] * Xw[1] + R[2] * Xw[2] + t[0];
  const y = R[3] * Xw[0] + R[4] * Xw[1] + R[5] * Xw[2] + t[1];
  const z = R[6] * Xw[0] + R[7] * Xw[1] + R[8] * Xw[2] + t[2];
  const d = -z;
  if (!(d > 0)) return null;
  const u = U.fx * (x / d) + U.cx;
  const v = U.fy * (-y / d) + U.cy;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return { u, v, ndc: pixelToNdc(u, v, U.bw, U.bh), d };
}
