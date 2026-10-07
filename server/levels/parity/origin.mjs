// skylens 원본(NET-Challenge-S13/skylens 0122bd4) 클라이언트 도착 기록을 줄 단위로 옮긴 기준 모형(T10.10L).
// 출처·라이선스: NET-Challenge-S13/skylens (MIT License, Copyright (c) 2026 마당을 나온 드론 @ 넷챌린지 캠프 시즌 13).
// 대조표 기대값이 원본 동작과 같은지 따로 확인하는 데만 쓴다. 제품 기계(server/levels/state)를 부르지 않는다.
//
// 수준 번호 대응: 원본 수준은 사다리의 1부터 센 자리(ladder.ts:L8-L9, L41-L43), 우리 수준은 0..3.
//   원본 = 우리 + 1. 원본 top 은 설정한 사다리 길이다(ladder.ts:L49-L51). 원본 기본 사다리는 3칸
//   '1000,7000,30000'(config.ts:L97)이라 기본 top 은 3 이다. 이 대조표는 SKYLENS_CORE_LEVEL_STEPS=
//   250,1000,3500,7000 으로 띄운 4칸 코어를 가정해 top = 4 로 둔다(기본 top 이 아니다).
//   top 이 다르면 final 판정이 달라지므로 replayOrigin 은 { top } 을 받는다(기본 4, 3칸 확인용).
//   final 깃발은 송신 쪽에서 level >= top 으로 붙는다(orchestrator.ts:L343).

export const ORIGIN_COMMIT = '0122bd4';
// 4칸 사다리 가정값. 원본 기본은 3칸(config.ts:L97)이라 top 3 이다.
export const ORIGIN_TOP = 4;

/** 우리 수준 → 원본 수준(1..top, 4칸 가정이면 1..4). */
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
export function replayOrigin(arrivals, { top = ORIGIN_TOP } = {}) {
  // top 이 정수·1 이상이 아니면 final 판정이 무의미해지므로(null 이면 전부 final, NaN 이면 영영 아님) 거부한다.
  if (!Number.isInteger(top) || top < 1) throw new RangeError(`top 은 1 이상의 정수여야 한다: ${top}`);
  let chunks = 0; // splatScene.ts:L69 _chunks
  let refined = 0; // splatScene.ts:L70 _refined
  const bySegment = new Map(); // splatScene.ts:L74
  // splatReveal.ts:L40 pending. 원본은 슬랩(coreSegment % regionCount, L77) 단위 Float32Array 인데
  // 이 모형은 슬랩 접힘을 생략해 구간 단위 Map 에 float64 로 둔다(원본은 setFrame(statusViewer.ts:L545)으로 regionCount = boundaries+1(splatReveal.ts:L63-L65)이 정해진 뒤 도착을 받고, 구간 번호 ≥ regionCount 는 접힌다).
  // 생략한 두 가지는 cases.mjs NOT_MODELED 에 이름을 적어 두었다.
  const pending = new Map();
  for (const [segment, ourLevel] of arrivals) {
    const level = toOrigin(ourLevel);
    const final = level >= top; // orchestrator.ts:L343
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
    // splatReveal.ts:L76-L80. statusViewer.ts:L551-L552 가 도착마다 noteChunk 를 부르고 noteArrival 은
    // this.splatReveal?. 로 부른다. SplatReveal 은 splatCapable && recon 일 때만 만들어진다
    // (statusViewer.ts:L524-L526 조건). 이 모형은 그 조건이 참인 경우만 옮긴 것이다.
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
