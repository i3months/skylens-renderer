// T03.9 결정성 검사
// 같은 입력으로 packChunk를 여러 번 실행하여 바이트가 모두 같은지 확인한다.
import { packChunk } from '../pack/index.mjs';
import { AssetFormatError } from '../../../contracts/asset/index.mjs';

/**
 * 같은 입력으로 packFn을 times 번 돌려 바이트가 모두 같은지 본다.
 * @param {Parameters<typeof import('../../../contracts/asset/stubs.mjs').packChunk>[0]} input
 * @param {number} [times] 기본 2. 2 이상의 정수(0·1 은 비교할 쌍이 없어 거부한다)
 * @param {(input: object) => Uint8Array} [packFn] 기본은 ../pack/index.mjs 의 packChunk
 * @returns {{identical: boolean, firstDiffOffset: number | null}}
 */
export function checkDeterminism(input, times = 2, packFn = packChunk) {
  if (!Number.isInteger(times) || times < 2) {
    throw new AssetFormatError('field', 'times must be an integer >= 2');
  }

  // 첫 결과만 보관하고 나머지는 나올 때마다 바로 비교
  let first = null;
  for (let i = 0; i < times; i++) {
    const current = packFn(input);
    // packFn 결과는 Uint8Array 여야 한다(null·문자열이면 비교가 무의미)
    if (!(current instanceof Uint8Array)) throw new AssetFormatError('field', `packFn result ${i} is not Uint8Array`);
    if (first === null) {
      first = current;
      continue;
    }
    // 길이가 다르면 짧은 쪽 길이에서 다름
    if (first.length !== current.length) {
      return { identical: false, firstDiffOffset: Math.min(first.length, current.length) };
    }
    for (let j = 0; j < first.length; j++) {
      if (first[j] !== current[j]) return { identical: false, firstDiffOffset: j };
    }
  }
  return { identical: true, firstDiffOffset: null };
}
