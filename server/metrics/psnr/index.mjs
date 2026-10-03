// PSNR(피크 신호 대 잡음비) 및 빈 픽셀 비율 계산

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {number} PSNR 값 (dB). a === b 면 Infinity, 다르면 10·log10(65025/MSE).
 * @throws {Error} 길이 다르거나 비어있으면 'psnr:' Error.
 */
export function psnr(a, b) {
  // 입력 타입 검증
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
    throw new Error('psnr: 입력은 Uint8Array여야 함');
  }

  // 길이 검증
  if (a.length === 0 || b.length === 0) {
    throw new Error('psnr: 입력이 비어있음');
  }

  if (a.length !== b.length) {
    throw new Error('psnr: 입력 길이가 다름');
  }

  // MSE(평균 제곱오차) 계산
  let mse = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    mse += diff * diff;
  }
  mse /= a.length;

  // PSNR 계산: PSNR = 10·log10(255²/MSE)
  if (mse === 0) {
    return Infinity;
  }
  return 10 * Math.log10(65025 / mse);
}

/**
 * @param {Object} result RenderResult 객체
 * @param {Int32Array} result.index 픽셀 점 번호 배열(빈 픽셀은 -1)
 * @returns {number} 빈 픽셀 비율 (0 ≤ ratio ≤ 1)
 * @throws {Error} 입력이 유효하지 않으면 'psnr:' Error.
 */
export function emptyRatio(result) {
  // 입력 검증
  if (!result || typeof result !== 'object') {
    throw new Error('psnr: 결과가 객체가 아님');
  }

  if (!(result.index instanceof Int32Array)) {
    throw new Error('psnr: index는 Int32Array여야 함');
  }

  const total = result.index.length;
  if (total === 0) {
    throw new Error('psnr: 빈 결과');
  }

  // index === -1 인 픽셀 개수 세기
  let emptyCount = 0;
  for (let i = 0; i < total; i++) {
    if (result.index[i] === -1) {
      emptyCount++;
    }
  }

  return emptyCount / total;
}
