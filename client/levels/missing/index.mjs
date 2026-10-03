// "없음" 표시 상태(T10.5). 도착하지 않은 구간은 그리지도 메우지도 않고, 목록에서 숨기지도 않는다.
// 입력은 계약의 SegmentState 목록이며, 이 모듈은 입력을 바꾸지 않는 순수 함수만 둔다.
import { NONE, assertLevel, assertSegmentId } from '../../../contracts/levels/index.mjs';

/** 도착 전 구간에 표시하는 고정 문자열. */
export const MISSING_LABEL = '없음';

function pieceCount(piece) {
  const count = piece?.count;
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function describeOne(state) {
  if (state === null || typeof state !== 'object') throw new TypeError('SegmentState 는 객체여야 한다');
  const { segmentId, level, missing, pieces } = state;
  assertSegmentId(segmentId);
  if (typeof missing !== 'boolean') throw new TypeError(`missing 은 불리언이어야 한다: ${segmentId}`);
  if (!Array.isArray(pieces)) throw new TypeError(`pieces 는 배열이어야 한다: ${segmentId}`);
  if (level !== NONE) assertLevel(level);
  if (missing !== (level === NONE)) {
    throw new TypeError(`level 과 missing 이 어긋난다: 구간 ${segmentId}, level ${level}, missing ${missing}`);
  }
  if (missing) {
    if (pieces.length !== 0) throw new TypeError(`없음 구간에 조각이 있다: ${segmentId}`);
    return { segmentId, missing: true, renderPointCount: 0, label: MISSING_LABEL };
  }
  let renderPointCount = 0;
  for (const piece of pieces) renderPointCount += pieceCount(piece);
  return { segmentId, missing: false, renderPointCount, label: null };
}

/**
 * 구간마다 표시 정보를 돌려준다. 입력 순서와 개수를 그대로 유지한다.
 * @param {import('../../../contracts/levels/index.mjs').SegmentState[]} states
 * @returns {{segmentId:number, missing:boolean, renderPointCount:number, label:string|null}[]}
 */
export function describeSegments(states) {
  if (!Array.isArray(states)) throw new TypeError('states 는 배열이어야 한다');
  return states.map(describeOne);
}

/** 도착 전("없음") 구간 번호 목록. 입력 순서를 유지한다. */
export function missingSegmentIds(states) {
  return describeSegments(states).filter((d) => d.missing).map((d) => d.segmentId);
}
