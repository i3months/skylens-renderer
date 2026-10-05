// 관제탑 입력 층 카메라 변환(T15.4.3). 계약: contracts/controlview/input.mjs TOWER_INPUT_MODULES.camera.
// Pose {pos, yaw, pitch} → CameraPose {pos, quat, fovY}(contracts/statusview). 순수 JS, Math 만 사용.
//
// 좌표·축:
//   - 세계는 GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m.
//   - 카메라 축은 contracts/raster 규약(OpenCV: x 오른쪽, y 아래, z 앞). X_c = R·X_w + t.
//   - quat 는 카메라→ENU 회전(능동, 열 j = 카메라 j 번째 축의 ENU 방향). view.R 은 그 전치다(syncCamera).
//   - yaw: 0 = 북(+y), 시계 방향(동쪽 쪽)이 +. pitch: 위가 +. 단위 rad.
//
// 회전 구성(카메라→ENU):
//   M = Rz(−yaw) · Rx(pitch − π/2)
//   Rx(−π/2) 가 기준 자세(yaw=0, pitch=0)를 만든다: 앞(z)=+y(북), 오른쪽(x)=+x(동), 아래(y)=−z.
//   Rx(pitch) 는 오른쪽 축(ENU x) 둘레로 앞을 위로 든다. Rz(−yaw) 는 위(+z) 둘레 시계 방향 회전.
//   따라서 앞 = (sin yaw·cos pitch, cos yaw·cos pitch, sin pitch), 오른쪽 = (cos yaw, −sin yaw, 0).
//
// 쿼터니언 규약: (x, y, z, w) 순서, 단위 길이, Hamilton 곱.
//   q = qz(−yaw) ⊗ qx(pitch − π/2), qx(a) = (sin(a/2), 0, 0, cos(a/2)), qz(b) = (0, 0, sin(b/2), cos(b/2)).
//   q 와 −q 는 같은 회전이므로 부호를 하나로 정한다: w ≥ 0. w = 0 이면 (x, y, z) 중 첫 0 아닌 성분을 양수로 둔다.
//   −0 은 +0 으로 바꾼다.
//
// 입력 규칙(검사가 모두 끝난 뒤에만 결과를 만든다):
//   - pose 가 객체가 아니거나 pos 가 길이 3 배열이 아니거나 pos 원소·yaw·pitch·fovYRad 가 number 가 아니면 TypeError.
//   - pos 원소·yaw·pitch 가 유한하지 않으면 RangeError. pos 원소는 float32 로도 유한해야 한다(syncCamera·VIEW_UPDATE 와 같음).
//   - fovYRad 는 0<fovY<π 이고 float32 로 반올림한 값도 0<fovY<π 여야 한다(syncCamera 와 같음). 위반은 RangeError.
// 결과는 새 배열이고 입력 pose 를 바꾸지 않는다.

/** −0 을 +0 으로. */
function z0(x) {
  return x === 0 ? 0 : x;
}

function finiteNumber(v, name) {
  if (typeof v !== 'number') throw new TypeError(`${name} 는 number 여야 한다`);
  if (!Number.isFinite(v)) throw new RangeError(`${name} 는 유한해야 한다: ${String(v)}`);
}

/**
 * 쿼터니언 부호 규약 적용: w ≥ 0, w = 0 이면 (x, y, z) 의 첫 0 아닌 성분 > 0.
 * @param {number[]} q 단위 쿼터니언 (x, y, z, w)
 * @returns {number[]}
 */
export function canonicalQuat(q) {
  let s = 1;
  if (q[3] < 0) s = -1;
  else if (q[3] === 0) {
    for (let i = 0; i < 3; i += 1) {
      if (q[i] !== 0) {
        s = q[i] < 0 ? -1 : 1;
        break;
      }
    }
  }
  return [z0(s * q[0]), z0(s * q[1]), z0(s * q[2]), z0(s * q[3])];
}

/**
 * Pose → CameraPose. 계약: contracts/controlview/input.mjs TOWER_INPUT_MODULES.camera.
 * @param {{pos:number[], yaw:number, pitch:number}} pose
 * @param {number} fovYRad 세로 시야(rad, 0<fovY<π)
 * @returns {{pos:number[], quat:number[], fovY:number}}
 */
export function poseToCameraPose(pose, fovYRad) {
  // ── 검사 ──
  if (pose === null || typeof pose !== 'object') throw new TypeError('pose 는 객체여야 한다');
  const { pos, yaw, pitch } = pose;
  if (!Array.isArray(pos) || pos.length !== 3) throw new TypeError('pos 는 길이 3 배열이어야 한다');
  for (let i = 0; i < 3; i += 1) {
    finiteNumber(pos[i], `pos[${i}]`);
    if (!Number.isFinite(Math.fround(pos[i]))) throw new RangeError(`pos[${i}] 가 float32 범위를 넘는다: ${pos[i]}`);
  }
  finiteNumber(yaw, 'yaw');
  finiteNumber(pitch, 'pitch');
  if (typeof fovYRad !== 'number') throw new TypeError('fovYRad 는 number 여야 한다');
  const f32Fov = Math.fround(fovYRad);
  if (!(fovYRad > 0 && fovYRad < Math.PI) || !(f32Fov > 0 && f32Fov < Math.PI)) {
    throw new RangeError(`fovYRad 는 0<fovY<π 여야 한다(float32 반올림 후에도): ${String(fovYRad)}`);
  }

  // ── 결과 ──
  const a = (pitch - Math.PI / 2) / 2; // qx 반각
  const b = -yaw / 2; // qz 반각
  const sx = Math.sin(a), cx = Math.cos(a), sz = Math.sin(b), cz = Math.cos(b);
  // qz(b) ⊗ qx(a) = (cz·sx, sz·sx, sz·cx, cz·cx)
  const raw = [cz * sx, sz * sx, sz * cx, cz * cx];
  const n = Math.hypot(raw[0], raw[1], raw[2], raw[3]); // 해석적으로 1, 반올림 오차만 걷어낸다
  const quat = canonicalQuat(raw.map((v) => v / n));
  return { pos: [z0(pos[0]), z0(pos[1]), z0(pos[2])], quat, fovY: fovYRad };
}
