// T06.1 투영: 세계 점 → 픽셀(u, v)과 깊이 d. 규약은 contracts/raster(renderer_basis §2) 그대로다.
//   X_c = R·X_w + t (R 은 행 우선 9개), d = X_c.z
//   u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy
// d <= 0(카메라 뒤 또는 카메라 평면 위)이면 d 만 믿고 u, v 는 NaN 이다.
import { assertCamera } from '../../../contracts/raster/index.mjs';

const ERR = 'raster:';

// 유한한 3-벡터인지 검사한다(배열 또는 길이 3 의 형식 배열).
function assertVec3(xw) {
  const ok = (Array.isArray(xw) || ArrayBuffer.isView(xw)) && xw.length === 3;
  if (!ok) throw new Error(`${ERR} xw 는 3-벡터여야 함`);
  for (let i = 0; i < 3; i += 1) {
    if (typeof xw[i] !== 'number' || !Number.isFinite(xw[i])) throw new Error(`${ERR} xw[${i}] 는 유한 수여야 함: ${String(xw[i])}`);
  }
}

// 검사를 마친 카메라로 한 점을 투영해 out[o..o+2] 에 (u, v, d) 를 쓴다. project 와 projectMany 가 같이 쓴다.
function projectInto(camera, x, y, z, out, o) {
  const { R, t, K } = camera;
  const xc = R[0] * x + R[1] * y + R[2] * z + t[0];
  const yc = R[3] * x + R[4] * y + R[5] * z + t[1];
  const d = R[6] * x + R[7] * y + R[8] * z + t[2];
  out[o + 2] = d;
  if (d > 0) {
    out[o] = (K.fx * xc) / d + K.cx;
    out[o + 1] = (K.fy * yc) / d + K.cy;
  } else {
    out[o] = NaN;
    out[o + 1] = NaN;
  }
}

/** 한 점을 투영한다. 반환 {u, v, d}. 입력이 틀리면 'raster:' 로 시작하는 Error. */
export function project(camera, xw) {
  assertCamera(camera);
  assertVec3(xw);
  const out = [0, 0, 0];
  projectInto(camera, xw[0], xw[1], xw[2], out, 0);
  return { u: out[0], v: out[1], d: out[2] };
}

/**
 * 여러 점을 한꺼번에 투영한다. positions 는 xyz 를 이어 붙인 Float32Array(길이 3N),
 * out 은 점마다 (u, v, d) 를 담을 Float64Array(길이 3N 이상). out 을 그대로 돌려준다.
 * 결과는 점마다 project 와 같다(Float32 좌표를 그대로 배정밀도로 읽는다).
 */
export function projectMany(camera, positions, out) {
  assertCamera(camera);
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) throw new Error(`${ERR} positions 는 길이가 3 의 배수인 Float32Array 여야 함`);
  if (!(out instanceof Float64Array) || out.length < positions.length) throw new Error(`${ERR} out 은 길이 ${positions.length} 이상의 Float64Array 여야 함`);
  const n = positions.length / 3;
  for (let i = 0; i < n; i += 1) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error(`${ERR} positions 의 점 ${i} 가 유한하지 않음`);
    projectInto(camera, x, y, z, out, 3 * i);
  }
  return out;
}
