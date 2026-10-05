// 드레이프 음영 비율(T15.2). 지형 색 ÷ 기준색의 음영 비율로 드레이프를 보정한다.
// 음영 비율: terrainRgb 채널 평균 ÷ baseRgb 채널 평균. baseRgb 평균이 0 이면 1.
// 결과는 [0, 1.4] 로 제한. 입력은 길이 3, 유한, 0..255 범위 검사.

const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * 지형 화소 색의 음영 비율을 계산한다.
 * 비율 = terrainRgb 채널 평균 ÷ baseRgb 채널 평균, [0, 1.4] 로 클램프.
 * baseRgb 평균이 0 이면 1 을 반환.
 * @param {[number, number, number]} terrainRgb - 지형 화소 색 [r, g, b] (0..255)
 * @param {[number, number, number]} baseRgb - 기준색 [r, g, b] (0..255)
 * @returns {number} 음영 비율 (0..1.4)
 * @throws {RangeError} 입력이 [0, 255] 범위 밖이거나 길이·유한성 오류
 */
export function shadeRatio(terrainRgb, baseRgb) {
  // 입력 검증
  if (!terrainRgb || typeof terrainRgb.length !== 'number' || terrainRgb.length !== 3) {
    throw new RangeError('shadeRatio: terrainRgb 는 길이 3 배열이어야 함');
  }
  if (!baseRgb || typeof baseRgb.length !== 'number' || baseRgb.length !== 3) {
    throw new RangeError('shadeRatio: baseRgb 는 길이 3 배열이어야 함');
  }

  // 채널 유한성 및 범위 검사
  for (let i = 0; i < 3; i += 1) {
    if (!isFiniteNum(terrainRgb[i]) || terrainRgb[i] < 0 || terrainRgb[i] > 255) {
      throw new RangeError(`shadeRatio: terrainRgb[${i}] 는 0..255 범위의 유한 수여야 함: ${String(terrainRgb[i])}`);
    }
    if (!isFiniteNum(baseRgb[i]) || baseRgb[i] < 0 || baseRgb[i] > 255) {
      throw new RangeError(`shadeRatio: baseRgb[${i}] 는 0..255 범위의 유한 수여야 함: ${String(baseRgb[i])}`);
    }
  }

  // 채널 평균 계산
  const terrainAvg = (terrainRgb[0] + terrainRgb[1] + terrainRgb[2]) / 3;
  const baseAvg = (baseRgb[0] + baseRgb[1] + baseRgb[2]) / 3;

  // baseRgb 평균이 0 이면 1 반환
  if (baseAvg === 0) {
    return 1;
  }

  // 비율 계산 및 클램프
  const ratio = terrainAvg / baseAvg;
  return Math.max(0, Math.min(1.4, ratio));
}

/**
 * 음영 비율을 RGB 각 채널에 적용한다.
 * @param {[number, number, number]} rgb - 색상 [r, g, b] (0..255)
 * @param {number} ratio - 음영 비율
 * @returns {[number, number, number]} 적용된 색상 [r, g, b] (0..255)
 */
export function applyRatio(rgb, ratio) {
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] * ratio))),
    Math.max(0, Math.min(255, Math.round(rgb[1] * ratio))),
    Math.max(0, Math.min(255, Math.round(rgb[2] * ratio))),
  ];
}
