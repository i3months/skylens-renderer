// T04.8 법선 정규화·검사
import { PointsError } from '../../../contracts/points/index.mjs';

const MIN_LEN = 1e-12;

/** 법선을 단위 벡터로. 길이 0(<1e-12)·비유한은 (0,0,0) 으로 두고 invalid 에 인덱스만 기록한다.
 * @param {Float32Array} normals 3n @returns {{normals: Float32Array, invalid: Uint32Array}} */
export function normalizeNormals(normals) {
  if (!(normals instanceof Float32Array) || normals.length % 3 !== 0) {
    throw new PointsError('size', 'normals length must be a multiple of 3');
  }
  const n = normals.length / 3;
  const out = new Float32Array(normals.length);
  const bad = [];
  for (let i = 0; i < n; i++) {
    const x = normals[3 * i], y = normals[3 * i + 1], z = normals[3 * i + 2];
    // f64 로 계산(f32 제곱 오버플로 방지)
    const len = Math.sqrt(x * x + y * y + z * z);
    if (!Number.isFinite(len) || len < MIN_LEN) { bad.push(i); continue; }
    // 방향만 쓰므로 단위화. 3장 평균이라 길이 1 미보장(renderer_basis §7-2). 27 B에 신뢰도 필드 없음(§7-4).
    out[3 * i] = x / len;
    out[3 * i + 1] = y / len;
    out[3 * i + 2] = z / len;
  }
  return { normals: out, invalid: Uint32Array.from(bad) };
}
