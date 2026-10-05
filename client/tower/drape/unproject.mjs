// 관제탑 드레이프 화소 역투영(T15.2). 계약: contracts/controlview/drape.mjs DRAPE_MODULES.unproject.
// 규약은 contracts/raster(renderer_basis §2) 그대로다.
//   X_c = R·X_w + t (R 은 행 우선 9개), 깊이 d = X_c.z
//   화소 (i, j) 칸 중심은 (u, v) = (i + 0.5, j + 0.5)
//   X_c = d·K⁻¹·[u, v, 1]ᵀ = (d·(u − cx)/fx, d·(v − cy)/fy, d)
//   X_w = Rᵀ·(X_c − t)    (R 은 정규직교이므로 R⁻¹ = Rᵀ)
// 월드는 GeoAnchor 기준 ENU(x 동, y 북, z 위), 1 unit = 1 m.
// 클라이언트 코드이므로 contracts/ 만 가져온다.
import { assertCamera } from '../../../contracts/raster/index.mjs';

/**
 * 화소 (i, j) 칸 중심과 깊이로 ENU 점을 구한다.
 * i, j 는 유한 수(정수면 칸 번호, 소수도 받는다). 화면 밖 번호도 그대로 계산한다.
 * 카메라가 틀리면 assertCamera 의 Error, i·j 가 유한하지 않거나 depth 가 양의 유한 수가 아니면 RangeError.
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {number} i 가로 화소 번호
 * @param {number} j 세로 화소 번호
 * @param {number} depth 깊이 X_c.z (m)
 * @returns {{x:number, y:number, z:number}}
 */
export function pixelToEnu(camera, i, j, depth) {
  assertCamera(camera);
  if (typeof i !== 'number' || !Number.isFinite(i)) throw new RangeError(`drape: i 는 유한 수여야 한다: ${String(i)}`);
  if (typeof j !== 'number' || !Number.isFinite(j)) throw new RangeError(`drape: j 는 유한 수여야 한다: ${String(j)}`);
  if (typeof depth !== 'number' || !Number.isFinite(depth) || !(depth > 0)) {
    throw new RangeError(`drape: depth 는 양의 유한 수여야 한다: ${String(depth)}`);
  }
  const { K, R, t } = camera;
  const u = i + 0.5;
  const v = j + 0.5;
  const a = (depth * (u - K.cx)) / K.fx - t[0];
  const b = (depth * (v - K.cy)) / K.fy - t[1];
  const c = depth - t[2];
  // Rᵀ 를 곱한다: (Rᵀ·w)_k = Σ_r R[r][k]·w_r (행 우선이므로 R[r*3+k])
  const x = R[0] * a + R[3] * b + R[6] * c;
  const y = R[1] * a + R[4] * b + R[7] * c;
  const z = R[2] * a + R[5] * b + R[8] * c;
  // 극단 입력으로 넘침이 나면 조용히 돌려주지 않는다.
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new RangeError('drape: 역투영 결과가 유한하지 않다(입력이 너무 극단적이다)');
  }
  return { x, y, z };
}

/**
 * 화소 루프용 역투영 준비. 카메라를 한 번 검사하고 계수(K·R·t)를 평평한 Float64Array 에 담는다.
 * 계수 배치: [cx, cy, fx, fy, t0, t1, t2, R0..R8] (16개).
 * pixelToEnuInto 는 pixelToEnu 와 같은 순서로 같은 연산을 하므로 결과가 비트 단위로 같다(K 역을 곱셈으로 바꾸지 않는 까닭).
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @returns {Float64Array}
 */
export function prepareUnproject(camera) {
  assertCamera(camera);
  const { K, R, t } = camera;
  const c = new Float64Array(16);
  c[0] = K.cx; c[1] = K.cy; c[2] = K.fx; c[3] = K.fy;
  c[4] = t[0]; c[5] = t[1]; c[6] = t[2];
  for (let k = 0; k < 9; k++) c[7 + k] = R[k];
  return c;
}

/**
 * 검사 없는 역투영. coef 는 prepareUnproject 결과, depth 는 호출자가 양의 유한 수임을 보장한다.
 * out[0..2] 에 (x, y, z) 를 쓰고 새 객체를 만들지 않는다. 넘침 검사도 하지 않으므로 호출자가 유한성을 본다.
 * @param {Float64Array} coef
 * @param {number} i
 * @param {number} j
 * @param {number} depth
 * @param {Float64Array|number[]} out
 */
export function pixelToEnuInto(coef, i, j, depth, out) {
  const u = i + 0.5;
  const v = j + 0.5;
  const a = (depth * (u - coef[0])) / coef[2] - coef[4];
  const b = (depth * (v - coef[1])) / coef[3] - coef[5];
  const c = depth - coef[6];
  out[0] = coef[7] * a + coef[10] * b + coef[13] * c;
  out[1] = coef[8] * a + coef[11] * b + coef[14] * c;
  out[2] = coef[9] * a + coef[12] * b + coef[15] * c;
}
