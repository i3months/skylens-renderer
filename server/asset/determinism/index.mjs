// T03.9 결정성 검사
// 같은 입력으로 packChunk를 여러 번 실행하여 바이트가 모두 같은지 확인한다.

/**
 * 같은 입력으로 packChunk를 times 번 돌려 바이트가 모두 같은지 본다.
 * @param {import('../../contracts/asset/stubs.mjs').packChunk 첫 인자} input
 * @param {number} [times] 기본 2
 * @param {Function} [packFn] packChunk 함수. 기본은 ../pack/index.mjs의 packChunk
 * @returns {{identical: boolean, firstDiffOffset: number | null}}
 */
export function checkDeterminism(input, times = 2, packFn) {
  // times 유효성 검사
  if (typeof times !== 'number' || times < 0) {
    throw new Error('times must be a non-negative number');
  }

  // packFn 기본값: ../pack/index.mjs의 packChunk 동기 로드 시도
  // 패키 모듈이 없으면 사용 시점에 에러
  if (!packFn) {
    // 동기 모듈 로드를 위해 createRequire 사용
    try {
      // ESM 환경에서 동적 로드할 수 없으므로 호출자가 packFn을 명시적으로 제공해야 함
      throw new Error(
        'packFn not provided. ' +
        'In ESM, packFn must be provided explicitly, or load ../pack/index.mjs and pass its packChunk function.'
      );
    } catch (err) {
      throw err;
    }
  }

  // times가 0이면 실행하지 않음 → identical true
  if (times === 0) {
    return { identical: true, firstDiffOffset: null };
  }

  // times번 실행하여 결과 수집
  const results = [];
  for (let i = 0; i < times; i++) {
    const result = packFn(input);
    results.push(result);
  }

  // times가 1이면 비교 대상 없음 → identical true
  if (results.length === 1) {
    return { identical: true, firstDiffOffset: null };
  }

  // 첫 번째 결과를 기준으로 나머지 비교
  const first = results[0];

  for (let i = 1; i < results.length; i++) {
    const current = results[i];

    // 길이가 다르면 짧은 쪽 길이에서 다름
    if (first.length !== current.length) {
      return {
        identical: false,
        firstDiffOffset: Math.min(first.length, current.length),
      };
    }

    // 바이트별 비교
    for (let j = 0; j < first.length; j++) {
      if (first[j] !== current[j]) {
        return {
          identical: false,
          firstDiffOffset: j,
        };
      }
    }
  }

  // 모든 결과가 동일함
  return {
    identical: true,
    firstDiffOffset: null,
  };
}
