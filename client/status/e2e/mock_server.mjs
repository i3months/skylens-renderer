// 통합 시험용 모의 코어 + 모의 렌더 서버(T13.8).
// 모의 코어: (구간, 수준) 도착 이벤트 열과 조각별 점 수 표를 갖는다.
// 모의 렌더 서버: 이벤트마다 PIECE(pieceSeq 연속) 들과 LEVEL_ARRIVED 하나를 client/proto encodeMessage 로 선 바이트로 만들고,
// 받는 쪽은 decodeMessage 로 풀어 StatusView.handle 에 넣는다(어댑터 송출 순서: 조각들 → LEVEL_ARRIVED).
import { encodeMessage, decodeMessage } from '../../proto/index.mjs';

/** 조각 바이트의 앞 4 B(u32 LE)를 점 수로 읽는다(시험용 countOf). */
export function countOfTestChunk(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) throw new TypeError('시험 조각은 4 B 이상');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

/** 점 수를 앞 4 B 에 담은 시험 조각(뒤에 1 B 채움을 붙여 길이와 점 수가 무관하게 한다). */
export function testChunk(count) {
  const u8 = new Uint8Array(5);
  new DataView(u8.buffer).setUint32(0, count, true);
  u8[4] = 0xab;
  return u8;
}

/**
 * 3구간 × 4수준. 조각 점 수 표: COUNTS[segmentId][level] = 조각마다의 점 수(chunkIndex 순).
 *   구간 0: 수준마다 조각 2 개.  구간 1: 수준마다 조각 1 개.  구간 2: 수준 0·3 은 3 개, 1·2 는 2 개.
 */
export const COUNTS = Object.freeze([
  [[10, 20], [30, 40], [50, 60], [70, 80]],
  [[5], [6], [7], [500]],
  [[1, 1, 1], [11, 12], [13, 14], [100, 200, 300]],
]);

/**
 * 도착 이벤트 열(구간마다 순서가 섞인다).
 *   구간 0: 0 → 1 → 2 → 3 (차례대로 교체)
 *   구간 1: 3 → 0 → 2 → 1 (수준 3 이 먼저 와 나머지를 모두 추월, 수준 1 이 가장 늦다)
 *   구간 2: 1 → 0 → 3 → 2 (0 은 추월당함, 3 이 1 을 교체, 2 는 추월당함)
 */
export const SCENARIO_EVENTS = Object.freeze([
  [0, 0], [1, 3], [2, 1], [0, 1], [1, 0], [2, 0], [0, 2], [2, 3], [1, 2], [0, 3], [2, 2], [1, 1],
]);

export function pieceKeyOf(segmentId, level, chunkIndex) {
  return { segmentId, level, lod: 0, chunkIndex, tileX: 0, tileY: 0 };
}

/** 모의 렌더 서버. 한 세션의 pieceSeq 를 1 부터 늘리며 선 바이트를 만든다. */
export function createMockRenderServer({ sessionId = 7, counts = COUNTS } = {}) {
  let nextSeq = 1;
  const sentPieces = new Map(); // pieceSeq -> PIECE 메시지(재전송용)
  return {
    welcome(resumed = false) {
      return [encodeMessage({ type: 'WELCOME', sessionId, resumed, nextPieceSeq: nextSeq })];
    },
    missing(segmentId) {
      return [encodeMessage({ type: 'MISSING', segmentId })];
    },
    error(code, text = '') {
      return [encodeMessage({ type: 'ERROR', code, text })];
    },
    /** 한 수준 도착: PIECE f..f+n−1 → LEVEL_ARRIVED(n, f). */
    levelArrival(segmentId, level) {
      const list = counts[segmentId][level];
      const first = nextSeq;
      const frames = list.map((c, i) => {
        const m = { type: 'PIECE', pieceSeq: nextSeq, key: pieceKeyOf(segmentId, level, i), chunk: testChunk(c) };
        sentPieces.set(nextSeq, m);
        nextSeq += 1;
        return encodeMessage(m);
      });
      frames.push(encodeMessage({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount: list.length, firstPieceSeq: first }));
      return frames;
    },
    /** 이미 보낸 pieceSeq 의 PIECE 를 같은 key 로 다시 보낸다(송출 실패 뒤 재전송). */
    resend(pieceSeq) {
      return [encodeMessage(sentPieces.get(pieceSeq))];
    },
    nextPieceSeq: () => nextSeq,
  };
}

/** 선 바이트 → s2c 메시지. */
export function decodeAll(frames) {
  return frames.map((b) => decodeMessage(b));
}

/** 프레임들을 풀어 view.handle 에 차례로 넣는다. */
export function feed(view, frames) {
  for (const m of decodeAll(frames)) view.handle(m);
}
