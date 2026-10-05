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

/**
 * 화소 루프용 음영 비율(검사 없음, 할당 없음). color[offset..offset+2] 를 지형 색으로 읽는다.
 * shadeRatio 와 같은 순서로 같은 연산을 하므로 결과가 같다. baseRgb 는 호출자가 미리(프레임당 1 회) 검사한다.
 * @param {ArrayLike<number>} color 지형 색 배열(rgb 연속)
 * @param {number} offset 화소의 첫 채널 위치(3·p)
 * @param {ArrayLike<number>} baseRgb 기준색
 * @returns {number}
 */
export function shadeRatioAt(color, offset, baseRgb) {
  const terrainAvg = (color[offset] + color[offset + 1] + color[offset + 2]) / 3;
  const baseAvg = (baseRgb[0] + baseRgb[1] + baseRgb[2]) / 3;
  if (baseAvg === 0) return 1;
  const ratio = terrainAvg / baseAvg;
  return Math.max(0, Math.min(1.4, ratio));
}

/**
 * applyRatio 의 할당 없는 판. src[srcOff..+2] 에 비율을 곱해 dst[dstOff..+2] 에 쓴다(결과는 applyRatio 와 같다).
 * @param {ArrayLike<number>} src
 * @param {number} srcOff
 * @param {number} ratio
 * @param {Uint8Array|number[]} dst
 * @param {number} dstOff
 */
export function applyRatioInto(src, srcOff, ratio, dst, dstOff) {
  // Math.max/min 대신 비교로 제한한다(값은 같다: 반올림 결과가 0..255 밖일 때만 바뀐다).
  let v = Math.round(src[srcOff] * ratio);
  dst[dstOff] = v < 0 ? 0 : v > 255 ? 255 : v;
  v = Math.round(src[srcOff + 1] * ratio);
  dst[dstOff + 1] = v < 0 ? 0 : v > 255 ? 255 : v;
  v = Math.round(src[srcOff + 2] * ratio);
  dst[dstOff + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * 프레임당 한 번 만드는 음영 비율 표. 표[c0 + c1 + c2] = shadeRatio([c0, c1, c2], baseRgb) (c 는 0..255 정수).
 * shadeRatio 는 채널 합(정수, 정확)에만 의존하므로 표를 써도 결과가 같다. baseRgb 는 호출자가 미리 검사한다.
 * @param {ArrayLike<number>} baseRgb
 * @returns {Float64Array} 길이 766
 */
export function shadeRatioTable(baseRgb) {
  const table = new Float64Array(766);
  const baseAvg = (baseRgb[0] + baseRgb[1] + baseRgb[2]) / 3;
  for (let sum = 0; sum < 766; sum++) {
    if (baseAvg === 0) { table[sum] = 1; continue; }
    const ratio = sum / 3 / baseAvg;
    table[sum] = Math.max(0, Math.min(1.4, ratio));
  }
  return table;
}

/**
 * 음영 적용 표. 표[(c0 + c1 + c2)·256 + c] = applyRatio 를 비율 shadeRatio([c0, c1, c2], baseRgb) 로 c 에 적용한 값.
 * 표본 색·지형 색이 모두 0..255 정수이므로 화소마다 곱셈·반올림 대신 표를 읽어도 결과가 같다.
 * 크기 766·256 바이트(약 196 KB). baseRgb 가 같으면 다시 쓸 수 있다(호출자가 보관). baseRgb 는 호출자가 미리 검사한다.
 * @param {ArrayLike<number>} baseRgb
 * @returns {Uint8Array}
 */
export function shadeLut(baseRgb) {
  const ratios = shadeRatioTable(baseRgb);
  const lut = new Uint8Array(766 * 256);
  for (let sum = 0; sum < 766; sum++) {
    const ratio = ratios[sum];
    const row = sum * 256;
    for (let c = 0; c < 256; c++) lut[row + c] = Math.max(0, Math.min(255, Math.round(c * ratio)));
  }
  return lut;
}
