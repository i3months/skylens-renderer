// 바이트 집계(byte ledger). 웹소켓 프레임 페이로드의 누적 바이트를 기록하고 예산 검사를 한다(T11.11).
// SPEC S6: 초기 단계 ≤ 15 MB(15,000,000 B), 구간당 ≤ 3 MB(3,000,000 B). SPEC 의 MB 는 10^6 B 이며 이 값은 고정이다.

export const INITIAL_BUDGET_BYTES = 15_000_000;  // 15 MB
export const SEGMENT_BUDGET_BYTES = 3_000_000;   // 3 MB

/**
 * @typedef {Object} ByteLedger
 * @property {(frameBytes: Uint8Array|number, info: {segmentId: number, phase: 'initial'|'segment'}) => void} record
 * @property {() => Map<number, number>} perSegment
 * @property {() => number} initialBytes
 * @property {(options?: {initialMax?: number, perSegmentMax?: number}) => {initial: boolean, segments: number[]}} overBudget
 */

/**
 * 바이트 집계 원장을 만든다.
 * @returns {ByteLedger}
 */
export function createByteLedger() {
  // 초기 단계의 총 바이트
  let initialTotal = 0;

  // 구간별 총 바이트: Map<segmentId, bytes>
  const segmentTotals = new Map();

  return {
    /**
     * 프레임 페이로드 바이트를 기록한다.
     * @param {Uint8Array|number} frameBytes - 프레임 페이로드 길이(바이트 수) 또는 배열의 크기
     * @param {Object} info
     * @param {number} info.segmentId - 구간 ID
     * @param {'initial'|'segment'} info.phase - 단계('initial' 또는 'segment')
     */
    record(frameBytes, info) {
      const { segmentId, phase } = info;

      // frameBytes 가 Uint8Array 이면 길이를 가져온다
      const bytes = frameBytes instanceof Uint8Array ? frameBytes.length : frameBytes;

      if (phase === 'initial') {
        initialTotal += bytes;
      } else if (phase === 'segment') {
        const current = segmentTotals.get(segmentId) || 0;
        segmentTotals.set(segmentId, current + bytes);
      }
    },

    /**
     * 구간별 누적 바이트를 돌려준다.
     * @returns {Map<number, number>}
     */
    perSegment() {
      return new Map(segmentTotals);
    },

    /**
     * 초기 단계의 누적 바이트를 돌려준다.
     * @returns {number}
     */
    initialBytes() {
      return initialTotal;
    },

    /**
     * 예산 초과 여부를 확인한다.
     * @param {Object} options
     * @param {number} [options.initialMax=15_000_000] - 초기 단계 예산(바이트)
     * @param {number} [options.perSegmentMax=3_000_000] - 구간당 예산(바이트)
     * @returns {{initial: boolean, segments: number[]}}
     *   initial: 초기 단계가 예산을 초과했는가
     *   segments: 예산을 초과한 구간 ID 배열(오름차순)
     */
    overBudget(options = {}) {
      const initialMax = options.initialMax ?? INITIAL_BUDGET_BYTES;
      const perSegmentMax = options.perSegmentMax ?? SEGMENT_BUDGET_BYTES;

      const overSegments = [];
      for (const [segmentId, bytes] of segmentTotals.entries()) {
        if (bytes > perSegmentMax) {
          overSegments.push(segmentId);
        }
      }
      overSegments.sort((a, b) => a - b);

      return {
        initial: initialTotal > initialMax,
        segments: overSegments,
      };
    },
  };
}
