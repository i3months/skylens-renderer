// 역투영(T06.2). renderer_basis §2 규약을 그대로 따른다.
//   X_c = (d·(u−cx)/fx, d·(v−cy)/fy, d)    픽셀 (u,v) 와 깊이 d 에서 카메라 좌표
//   X_w = Rᵀ·(X_c − t)                      X_c = R·X_w + t 의 역(R 은 정규직교이므로 R⁻¹ = Rᵀ)
// 카메라 검사는 계약의 assertCamera 를 쓴다. 틀린 입력은 'raster:' 로 시작하는 Error.
import { assertCamera } from '../../../contracts/raster/index.mjs';

const ERR = 'raster:';

/**
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {number} u 픽셀 가로 좌표(연속값, 정수는 칸의 왼쪽 위 모서리)
 * @param {number} v 픽셀 세로 좌표
 * @param {number} d 깊이 X_c.z (m, 양의 유한 수)
 * @returns {number[]} [xw, yw, zw]
 */
export function unproject(camera, u, v, d) {
  assertCamera(camera);
  for (const [n, x] of [['u', u], ['v', v]]) {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${ERR} ${n} 는 유한 수여야 함: ${String(x)}`);
  }
  if (typeof d !== 'number' || !Number.isFinite(d) || !(d > 0)) throw new Error(`${ERR} 깊이 d 는 양의 유한 수여야 함: ${String(d)}`);
  const { K, R, t } = camera;
  const xc = (d * (u - K.cx)) / K.fx;
  const yc = (d * (v - K.cy)) / K.fy;
  const zc = d;
  const a = xc - t[0];
  const b = yc - t[1];
  const c = zc - t[2];
  // Rᵀ 를 곱한다: (Rᵀ·w)_i = Σ_k R[k][i]·w_k (행 우선 저장이므로 R[k*3+i])
  const out = [
    R[0] * a + R[3] * b + R[6] * c,
    R[1] * a + R[4] * b + R[7] * c,
    R[2] * a + R[5] * b + R[8] * c,
  ];
  // 극단값(예: d 가 매우 큼)에서 넘침으로 비유한 값이 나오면 조용히 돌려주지 않는다.
  if (!out.every(Number.isFinite)) throw new Error(`${ERR} 역투영 결과가 유한하지 않음(입력이 너무 극단적임)`);
  return out;
}
