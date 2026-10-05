// 관제탑 추적 카메라 리그(T15.5). 계약: contracts/controlview/chase.mjs TOWER_CHASE_FORMULA.rig, TOWER_CHASE_MODULES.rig.
// 순수 JS, Math 만 사용. 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m. yaw 0 = 북(+y), 시계 방향이 +.
//
// 카메라 위치 = p − distM·(sin yaw, cos yaw, 0) + (0,0,heightM)
// 시선 지점   = p + lookAheadM·(sin yaw, cos yaw, 0)
// d = 시선 지점 − 카메라 위치,  yawCam = atan2(dx, dy),  pitchCam = atan2(dz, hypot(dx, dy))
//
// 퇴화 규칙:
//   - d 가 정확히 0 이면 방향이 없으므로 yaw = state.yaw, pitch = 0 으로 정한다.
//   - 수평 성분 hypot(dx, dy) 가 정확히 0 이고 dz ≠ 0 이면(바로 위·아래를 봄) yaw 는 정의되지 않으므로
//     state.yaw 를 쓰고 pitch 는 atan2(dz, 0) = ±π/2 이다.
// 입력 검사: 형식 위반 TypeError, 비유한 값 RangeError. 검사가 끝난 뒤에만 결과를 만든다.

function finite(v, name) {
  if (typeof v !== 'number') throw new TypeError(`${name} 는 number 여야 한다`);
  if (!Number.isFinite(v)) throw new RangeError(`${name} 는 유한해야 한다: ${String(v)}`);
}

/**
 * @param {{pos:number[], yaw:number}} state 감쇠된 목표 상태
 * @param {{distM:number, heightM:number, lookAheadM:number}} cfg
 * @returns {{pos:number[], yaw:number, pitch:number}} 카메라 Pose(새 배열)
 */
export function rigPose(state, cfg) {
  // ── 검사 ──
  if (state === null || typeof state !== 'object') throw new TypeError('state 는 객체여야 한다');
  if (cfg === null || typeof cfg !== 'object') throw new TypeError('cfg 는 객체여야 한다');
  const { pos, yaw } = state;
  if (!Array.isArray(pos) || pos.length !== 3) throw new TypeError('state.pos 는 길이 3 배열이어야 한다');
  for (let i = 0; i < 3; i += 1) finite(pos[i], `state.pos[${i}]`);
  finite(yaw, 'state.yaw');
  finite(cfg.distM, 'cfg.distM');
  finite(cfg.heightM, 'cfg.heightM');
  finite(cfg.lookAheadM, 'cfg.lookAheadM');

  // ── 결과 ──
  const { distM, heightM, lookAheadM } = cfg;
  const s = Math.sin(yaw), c = Math.cos(yaw);
  const eye = [pos[0] - distM * s, pos[1] - distM * c, pos[2] + heightM];
  const look = [pos[0] + lookAheadM * s, pos[1] + lookAheadM * c, pos[2]];
  const dx = look[0] - eye[0], dy = look[1] - eye[1], dz = look[2] - eye[2];
  const h = Math.hypot(dx, dy);
  let camYaw = yaw, camPitch = 0; // 퇴화 기본값
  if (h !== 0) {
    camYaw = Math.atan2(dx, dy);
    camPitch = Math.atan2(dz, h);
  } else if (dz !== 0) {
    camPitch = Math.atan2(dz, 0);
  }
  if (!Number.isFinite(eye[0]) || !Number.isFinite(eye[1]) || !Number.isFinite(eye[2])) {
    throw new RangeError('카메라 위치가 유한하지 않다(값이 너무 크다)');
  }
  return { pos: eye, yaw: camYaw, pitch: camPitch };
}
