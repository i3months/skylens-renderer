// tune_cli.mjs 의 인자 검증 함수들.

// 유효한 variant 값들.
const VALID_VARIANTS = ['flat_boxes', 'depth_noise', 'buildings'];

/**
 * 점 수와 시드를 검증한다. 둘 다 양의 정수여야 한다.
 * @param {string|number|undefined} countStr - 점 수 인자(문자열 또는 숫자)
 * @param {string|number|undefined} seedStr - 시드 인자(문자열 또는 숫자)
 * @returns {{count: number, seed: number}} 검증된 점 수와 시드
 * @throws {RangeError} 인자가 양의 정수가 아닐 때
 */
export function parseCountAndSeed(countStr, seedStr) {
  // 점 수 검증: 양의 정수만 받는다 (NaN, 'abc', -1, 1.5, 과학 기수법, 16진수, 공백 등 거부).
  if (countStr !== undefined) {
    if (!/^\d+$/.test(countStr) || !Number.isSafeInteger(Number(countStr)) || Number(countStr) <= 0) {
      throw new RangeError(`잘못된 점 수: ${JSON.stringify(countStr)}`);
    }
  }
  const count = countStr ? Number(countStr) : 2500000;

  // 시드 검증: 양의 정수만 받는다.
  if (seedStr !== undefined) {
    if (!/^\d+$/.test(seedStr) || !Number.isSafeInteger(Number(seedStr)) || Number(seedStr) <= 0) {
      throw new RangeError(`잘못된 시드: ${JSON.stringify(seedStr)}`);
    }
  }
  const seed = seedStr ? Number(seedStr) : 1;

  return { count, seed };
}

/**
 * variant 값을 검증한다.
 * @param {string|undefined} variantStr - variant 인자(문자열 또는 undefined)
 * @returns {string} 검증된 variant ('flat_boxes', 'depth_noise', 또는 'buildings')
 * @throws {RangeError} 알 수 없는 variant 일 때
 */
export function parseVariant(variantStr) {
  const variant = variantStr ?? 'flat_boxes';
  if (!VALID_VARIANTS.includes(variant)) {
    throw new RangeError(`알 수 없는 variant: ${JSON.stringify(variant)}`);
  }
  return variant;
}
