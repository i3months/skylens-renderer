// 렌더 뷰 도구(T06.10). GL 규약 시점을 OpenCV 카메라로 변환해 점군을 그린다.
// 입력: 점군(format 1), GL 규약 시점 배열(eye/target/up/width/height/fov_y_deg)
// 출력: 렌더링 결과 배열 (RGB+깊이+점 번호 버퍼)

import { assertCamera } from '../../contracts/raster/index.mjs';
import { cameraExtrinsics, assertView } from '../../bench/baseline/ref_images/index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';

const ERR = 'render_views:';

// fov_y_deg 하한(도). 근거: fy = (height/2)/tan(fov/2) 이므로 fov 가 극단적으로 작으면 fy 가 1e302 대로
// 폭주해 투영이 의미를 잃는다(예: 1e-300 → fy 4.6e302). 0.001° 는 720 px 높이에서 fy ≈ 4.1e7 px 로
// 실제 망원 렌즈(수 도)보다 3 자릿수 이상 좁은 값이라 정상 입력은 막지 않으면서 폭주만 거른다.
export const MIN_FOV_Y_DEG = 0.001;

// fov_y_deg 상한(도). fy = (height/2)/tan(fov/2) 이므로 fov 가 극단적으로 180에 가까우면 fy 가 0에 가까워
// 투영이 의미를 잃는다. 179.9° 는 360/(height/2) 에서 fy ≈ 1 px 이상의 합리적 값을 유지한다.
export const MAX_FOV_Y_DEG = 179.9;

/**
 * GL 규약 시점(eye/target/up/width/height/fov_y_deg)을 OpenCV 카메라로 변환한다.
 * GL: y-up, 카메라는 -z를 봄
 * OpenCV: z 앞(+z 축이 시선), y 아래, x 오른쪽
 * 변환: diag(1,-1,-1)
 *
 * @param {Object} vp 시점 객체
 * @param {number[]} vp.eye 카메라 위치(3-벡터)
 * @param {number[]} vp.target 바라보는 점(3-벡터)
 * @param {number[]} vp.up 상향 벡터(3-벡터)
 * @param {number} vp.width 이미지 너비(양의 정수)
 * @param {number} vp.height 이미지 높이(양의 정수)
 * @param {number} vp.fov_y_deg 수직 FOV(도, MIN_FOV_Y_DEG 이상 180 미만의 유한 숫자)
 * @returns {import('../../contracts/raster/index.mjs').Camera} OpenCV 카메라
 */
export function viewpointToCamera(vp) {
  if (!vp || typeof vp !== 'object') throw new Error(`${ERR} 시점이 객체가 아님`);
  const { eye, target, up, width, height, fov_y_deg } = vp;

  // 해상도(양의 정수)와 fov(문자열·NaN·0 이하·180 이상 거부)를 먼저 검사한다. 실패 메시지에 접두를 붙인다.
  try {
    assertView({ width, height, fov_y_deg });
  } catch (e) {
    throw new Error(`${ERR} ${e.message}`);
  }
  if (fov_y_deg < MIN_FOV_Y_DEG) throw new Error(`${ERR} fov_y_deg 는 ${MIN_FOV_Y_DEG} 이상이어야 함(fy 폭주 방지): ${fov_y_deg}`);
  if (fov_y_deg > MAX_FOV_Y_DEG) throw new Error(`${ERR} fov_y_deg 는 ${MAX_FOV_Y_DEG} 이하여야 함(fy 감소 방지): ${fov_y_deg}`);

  // GL 규약에서 외부 행렬(R, t) 구하기
  const { R: R_gl, t: t_gl } = cameraExtrinsics({ eye, target, up });

  // GL → OpenCV: diag(1,-1,-1) 적용
  // R_cv[i,j,k] (행 우선) 9개:
  // R_gl이 행 우선이므로:
  // R_cv = diag(1,-1,-1) · R_gl
  // Row 0: 1 · [R_gl[0], R_gl[1], R_gl[2]] = [R_gl[0], R_gl[1], R_gl[2]]
  // Row 1: -1 · [R_gl[3], R_gl[4], R_gl[5]] = [-R_gl[3], -R_gl[4], -R_gl[5]]
  // Row 2: -1 · [R_gl[6], R_gl[7], R_gl[8]] = [-R_gl[6], -R_gl[7], -R_gl[8]]
  const R = [
    R_gl[0], R_gl[1], R_gl[2],
    -R_gl[3], -R_gl[4], -R_gl[5],
    -R_gl[6], -R_gl[7], -R_gl[8],
  ];
  const t = [t_gl[0], -t_gl[1], -t_gl[2]];

  // 내부 행렬 K 계산
  const fov_y_rad = (fov_y_deg * Math.PI) / 180;
  const fy = (height / 2) / Math.tan(fov_y_rad / 2);
  const fx = fy; // 방형 픽셀
  const cx = width / 2;
  const cy = height / 2;

  const camera = {
    width,
    height,
    K: { fx, fy, cx, cy },
    R,
    t,
  };

  // 계약 검사
  assertCamera(camera);

  return camera;
}

/**
 * 점군을 여러 시점으로 렌더링한다.
 *
 * @param {Object} cloud 점군(format 1)
 * @param {number[]} viewpoints GL 규약 시점 배열
 * @param {Object} [opts] 옵션
 * @param {number} [opts.pointSizeM] 점 크기(m, 기본 0.05)
 * @returns {import('../../contracts/raster/index.mjs').RenderResult[]} 렌더링 결과 배열
 */
export function renderViews(cloud, viewpoints, opts) {
  if (!Array.isArray(viewpoints) || viewpoints.length === 0) {
    throw new Error(`${ERR} viewpoints는 비어있지 않은 배열이어야 함`);
  }
  if (!cloud || typeof cloud !== 'object') {
    throw new Error(`${ERR} cloud는 객체여야 함`);
  }

  const results = [];
  for (const vp of viewpoints) {
    const camera = viewpointToCamera(vp);
    const result = renderPoints(camera, cloud, opts);
    results.push(result);
  }

  return results;
}
