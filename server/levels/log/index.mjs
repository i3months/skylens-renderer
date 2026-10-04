// 수준 이력 기록 도우미(T10.7, 디버그용). 계약: contracts/levels/index.mjs 의 HistoryEntry.

/** 이력 한 줄씩 "seq segment level action" 문자열로. */
export function formatHistory(history) {
  return history.map((h) => `${h.seq} ${h.segmentId} ${h.level} ${h.action}`);
}

/** 이력에서 입력 열({segmentId, level})을 되돌린다. seq 가 0..n-1 연속이 아니면 RangeError. */
export function replayHistory(history) {
  return history.map((h, i) => {
    if (h.seq !== i) throw new RangeError(`seq 가 연속이 아니다: 위치 ${i} 의 seq ${h.seq}`);
    return { segmentId: h.segmentId, level: h.level };
  });
}
