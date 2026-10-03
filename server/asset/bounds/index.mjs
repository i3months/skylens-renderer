// T03.3 조각 경계 상자. 명세 format/ASSET_FORMAT.md §3, §5.1 의 위치 양자화 규칙을 따른다.
import { AssetFormatError, POSITION_Q_MAX, QUANT_EXP_MAX, QUANT_EXP_MIN } from '../../../contracts/asset/index.mjs';

/**
 * 점들의 축별 최솟값·최댓값(f64). 점이 0개이거나 유한하지 않은 값이 있으면 던진다.
 * @param {Float32Array|Float64Array} positions 3n
 * @returns {{min: [number, number, number], max: [number, number, number]}}
 */
export function computeBounds(positions) {
  if (!(positions instanceof Float32Array || positions instanceof Float64Array)) {
    throw new AssetFormatError('range', 'positions 는 Float32Array 또는 Float64Array 여야 한다');
  }
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new AssetFormatError('range', `positions 길이가 3의 양의 배수가 아니다: ${positions.length}`);
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (!Number.isFinite(v)) throw new AssetFormatError('range', `유한하지 않은 좌표: 점 ${i / 3} 축 ${a}`);
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

/**
 * 10, 9, 8 순서로 모든 축에서 (max − min)·2^k ≤ 65535 인 가장 큰 k. 없으면 AssetFormatError('range').
 * @param {[number, number, number]} min
 * @param {[number, number, number]} max
 * @returns {8|9|10}
 */
export function chooseQuantExp(min, max) {
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(min[a]) || !Number.isFinite(max[a])) throw new AssetFormatError('range', `유한하지 않은 경계: 축 ${a}`);
    if (min[a] > max[a]) throw new AssetFormatError('range', `min > max: 축 ${a}`);
  }
  for (let k = QUANT_EXP_MAX; k >= QUANT_EXP_MIN; k--) {
    const scale = 2 ** k; // 2 의 거듭제곱 곱은 f64 에서 정확하다
    if (max.every((m, a) => (m - min[a]) * scale <= POSITION_Q_MAX)) return /** @type {8|9|10} */ (k);
  }
  throw new AssetFormatError('range', '범위가 65535·2^-8 m 를 넘는다. 조각을 u 방향으로 나눠야 한다');
}

/**
 * 양자화 격자가 덮는 상자: [min, min + 65535·2^-qexp] 축별.
 * @param {[number, number, number]} min
 * @param {number} quantExp
 * @returns {{min: [number, number, number], max: [number, number, number]}}
 */
export function quantizedBox(min, quantExp) {
  if (!Number.isInteger(quantExp) || quantExp < QUANT_EXP_MIN || quantExp > QUANT_EXP_MAX) {
    throw new AssetFormatError('range', `quantExp 는 8..10 정수여야 한다: ${quantExp}`);
  }
  if (!min.every(Number.isFinite)) throw new AssetFormatError('range', 'min 이 유한하지 않다');
  const span = POSITION_Q_MAX * 2 ** -quantExp;
  return { min: [min[0], min[1], min[2]], max: [min[0] + span, min[1] + span, min[2] + span] };
}
