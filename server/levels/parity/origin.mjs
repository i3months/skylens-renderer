// skylens 원본(NET-Challenge-S13/skylens 0122bd4) 클라이언트 도착 기록을 줄 단위로 옮긴 기준 모형(T10.10L).
// 출처·라이선스: NET-Challenge-S13/skylens (MIT License, Copyright (c) 2026 마당을 나온 드론 @ 넷챌린지 캠프 시즌 13).
// 대조표 기대값이 원본 동작과 같은지 따로 확인하는 데만 쓴다. 제품 기계(server/levels/state)를 부르지 않는다.
//
// 수준 번호 대응: 원본 수준은 사다리의 1부터 센 자리(ladder.ts:L8-L9, L41-L43), 우리 수준은 0..3.
//   원본 = 우리 + 1. 4수준 사다리(250·1,000·3,500·7,000)에서 top = 4(ladder.ts:L49-L51).
//   final 깃발은 송신 쪽에서 level >= top 으로 붙는다(orchestrator.ts:L343).

export const ORIGIN_COMMIT = '0122bd4';
export const ORIGIN_TOP = 4;

/** 우리 수준(0..3) → 원본 수준(1..4). */
export const toOrigin = (level) => level + 1;

/** 원본 alphaForLevel: splatReveal.ts:L26-L31 (0122bd4). 원본 수준 번호를 받는다. */
export function alphaForLevel(level, final) {
  if (final || level >= 4) return 1.0;
  if (level >= 3) return 0.95;
  if (level >= 2) return 0.8;
  return 0.62;
}

/**
 * SplatScene.noteChunk + SplatReveal.noteArrival 의 pending 갱신을 옮긴 모형.
 * arrivals 는 [segment, 우리 수준] 목록. 반환은 우리 수준 번호로 되돌린 구간별 상태와 원본 카운터.
 */
export function replayOrigin(arrivals) {
  let chunks = 0; // splatScene.ts:L69 _chunks
  let refined = 0; // splatScene.ts:L70 _refined
  const bySegment = new Map(); // splatScene.ts:L74
  const pending = new Map(); // splatReveal.ts:L40 (구간별, 슬랩 접힘 % regionCount 는 빼고 구간 단위로 둔다)
  for (const [segment, ourLevel] of arrivals) {
    const level = toOrigin(ourLevel);
    const final = level >= ORIGIN_TOP; // orchestrator.ts:L343
    // splatScene.ts:L152-L172
    chunks += 1;
    const prev = bySegment.get(segment);
    if (prev) {
      if (level > prev.level) {
        prev.level = level;
        refined += 1;
      }
      prev.final = prev.final || final;
    } else {
      bySegment.set(segment, { segment, level, final });
    }
    // splatReveal.ts:L76-L80 (statusViewer.ts:L551-L552 가 매 도착마다 둘 다 부른다)
    const target = alphaForLevel(level, final);
    if (target > (pending.get(segment) ?? 0)) pending.set(segment, target);
  }
  return {
    chunks,
    refined,
    /** 우리 표기의 구간 상태. 원본에 키가 없으면 없음(level -1). splatScene.ts:L266-L271 */
    state(segment) {
      const e = bySegment.get(segment);
      if (!e) return { level: -1, final: false, missing: true };
      return { level: e.level - 1, final: e.final, missing: false };
    },
    /** 그 구간 슬랩이 바라는 불투명도(splatReveal.ts:L40 pending). 도착 전이면 0. */
    revealTarget(segment) {
      return pending.get(segment) ?? 0;
    },
  };
}
