// 관제탑 오버레이 카메라(T15.6.1). 계약: contracts/controlview/overlay.mjs TOWER_OVERLAY_MODULES.view.
// 카메라 자세 → View(R 행 우선 9, t, K, width, height). 규칙은 현황판 syncCamera 의 view 와 같다
// (R = 카메라→ENU 회전의 전치, t = −R·pos, fy = (height/2)/tan(fovY/2), fx = fy, cx = width/2, cy = height/2).
// 입력 검사 위반(TypeError/RangeError)은 syncCamera 의 것을 그대로 따른다. 입력 pose·size 는 고치지 않는다.
import { syncCamera } from '../../status/camera/index.mjs';

/**
 * @param {{pos:number[], quat:number[], fovY:number}} pose
 * @param {{width:number, height:number, devicePixelRatio:number}} size
 * @returns {{R:number[], t:number[], K:{fx:number, fy:number, cx:number, cy:number}, width:number, height:number, devicePixelRatio:number}}
 */
export function poseToView(pose, size) {
  // 오버레이 크기는 CSS 픽셀 {width, height} 뿐이다(계약 Size). syncCamera 는 devicePixelRatio 를 요구하므로 없으면 1 로 채운다(view 계산에는 쓰이지 않는다).
  const sz = size !== null && typeof size === 'object' && size.devicePixelRatio === undefined ? { ...size, devicePixelRatio: 1 } : size;
  return syncCamera(pose, sz, 0).view; // viewSeq 는 view 에 쓰이지 않는다
}
