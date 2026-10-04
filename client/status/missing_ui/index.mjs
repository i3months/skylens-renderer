import { describeSegments, MISSING_LABEL } from '../../levels/missing/index.mjs';

/**
 * 도착 전 구간의 "없음" 안내를 돌려준다.
 * @param {import('../../../contracts/levels/index.mjs').SegmentState[]} states 구간 상태 목록
 * @returns {{segmentId: number, text: string}[]} 도착 전 구간만, 입력 순서 유지
 */
export function missingNotices(states) {
  // describeSegments 를 호출하면 입력 검증이 이루어진다.
  const described = describeSegments(states);
  // 도착 전 구간만 필터링하고 결과 형식으로 변환
  return described.filter((d) => d.missing).map((d) => ({ segmentId: d.segmentId, text: MISSING_LABEL }));
}
