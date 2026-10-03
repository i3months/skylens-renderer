// 렌더 뷰 도구(T06.10). GL 규약 시점을 OpenCV 카메라로 변환해 점군을 그린다.
// 입력: 점군(format 1), GL 규약 시점 배열(eye/target/up/width/height/fov_y_deg)
// 출력: 렌더링 결과 배열 (RGB+깊이+점 번호 버퍼)

import { assertCamera } from '../../contracts/raster/index.mjs';
import { cameraExtrinsics } from '../../bench/baseline/ref_images/index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';

const ERR = 'render_views:';

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
 * @param {number} vp.fov_y_deg 수직 FOV(도, 0 초과 180 미만)
 * @returns {import('../../contracts/raster/index.mjs').Camera} OpenCV 카메라
 */
export function viewpointToCamera(vp) {
  if (!vp || typeof vp !== 'object') throw new Error(`${ERR} 시점이 객체가 아님`);
  const { eye, target, up, width, height, fov_y_deg } = vp;

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
