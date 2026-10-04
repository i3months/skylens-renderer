// 기록하며 보내는 emit(T12.U 하위 작업 S1). 계약: ./contract.mjs
//   createRecordingEmit({ store, sessionId, send, encode? }) -> (message) => void
//   어댑터(server/adapter/core)의 emit 으로 넘긴다. 어댑터에는 encode 를 주지 않는다(메시지 객체를 받아 여기서 부호화한다).
// 순서: ① 부호화 ② 이어받기 저장소(server/ws/resume)에 기록 ③ send.
//   ① 에서 던지면 아무것도 기록·송출하지 않는다.
//   PIECE        : recordSent(sessionId, key, pieceSeq, chunk). false 면 send 하지 않고 RecordRejectedError 를 던진다.
//   LEVEL_ARRIVED: recordLevelArrived(sessionId, {segmentId, level, firstPieceSeq, pieceCount}) 를 send 보다 먼저.
//                  false 면 send 하지 않고 RecordRejectedError. 기록 뒤 send 가 던지면 그 예외를 그대로 던진다 — 어댑터는
//                  끝나지 않은 이벤트로 기억하고 같은 이벤트 재시도 때 같은 값으로 다시 부르며, 저장소 기록은 멱등이다.
//                  먼저 기록하므로 선에서 유실돼도 이어받기 resendPlan 이 되살린다.
//   MISSING      : 기록 없이 send.
//   그 밖의 type : 어댑터가 내보내지 않는 메시지다. 기록 규칙이 없어 TypeError 로 거부한다(아무것도 보내지 않는다).
//   send 의 반환값은 보지 않는다. 실패는 던지는 것으로만 알린다(conn.send 의 false 는 소켓 배압 신호라 실패가 아니다).
//   저장소 메서드가 던진 예외(RangeError 등)는 그대로 전파하고 send 하지 않는다.
import { encodeMessage } from '../../proto/codec/index.mjs';

/** 저장소가 기록을 거부했을 때(false: 상한·모르는 세션) 던진다. 그 메시지는 보내지 않았다. */
export class RecordRejectedError extends Error {
  /** @param {string} what 거부한 저장소 메서드 이름 @param {number} sessionId @param {string} detail */
  constructor(what, sessionId, detail) {
    super(`이어받기 저장소가 ${what} 를 거부했다(세션 ${sessionId}, ${detail}). 보내지 않았다`);
    this.name = 'RecordRejectedError';
    this.code = 'RECORD_REJECTED';
    this.method = what;
    this.sessionId = sessionId;
  }
}

/**
 * @param {Object} options
 * @param {import('./contract.mjs').SessionStoreLike} options.store
 * @param {number | (() => number)} options.sessionId  정수 또는 메시지마다 부르는 함수(HELLO 뒤에야 정해지는 경우)
 * @param {(bytes: Uint8Array) => unknown} options.send  던지면 실패. 반환값은 보지 않는다
 * @param {(message: object) => Uint8Array} [options.encode]  기본 encodeMessage
 * @returns {(message: object) => void}
 */
export function createRecordingEmit(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options 는 객체여야 한다');
  const { store, sessionId, send } = options;
  const encode = options.encode === undefined ? encodeMessage : options.encode;
  if (store === null || typeof store !== 'object'
    || typeof store.recordSent !== 'function' || typeof store.recordLevelArrived !== 'function') {
    throw new TypeError('store 는 recordSent·recordLevelArrived 를 가진 이어받기 저장소여야 한다');
  }
  if (typeof sessionId !== 'function' && !Number.isInteger(sessionId)) {
    throw new TypeError(`sessionId 는 정수 또는 함수여야 한다: ${String(sessionId)}`);
  }
  if (typeof send !== 'function') throw new TypeError('send 는 함수여야 한다');
  if (typeof encode !== 'function') throw new TypeError('encode 는 함수여야 한다');

  function currentSessionId() {
    const sid = typeof sessionId === 'function' ? sessionId() : sessionId;
    if (!Number.isInteger(sid)) throw new TypeError(`sessionId 가 정수가 아니다: ${String(sid)}`);
    return sid;
  }

  return function recordingEmit(message) {
    if (message === null || typeof message !== 'object') throw new TypeError('message 는 객체여야 한다');
    const { type } = message;
    if (type !== 'PIECE' && type !== 'LEVEL_ARRIVED' && type !== 'MISSING') {
      throw new TypeError(`기록 규칙이 없는 메시지 type: ${String(type)}`);
    }
    const bytes = encode(message); // ① 부호화 실패면 기록·송출 없음
    if (type === 'PIECE') {
      const sid = currentSessionId();
      if (store.recordSent(sid, message.key, message.pieceSeq, message.chunk) !== true) {
        throw new RecordRejectedError('recordSent', sid, `pieceSeq ${message.pieceSeq}`);
      }
    } else if (type === 'LEVEL_ARRIVED') {
      const sid = currentSessionId();
      const rec = {
        segmentId: message.segmentId,
        level: message.level,
        firstPieceSeq: message.firstPieceSeq,
        pieceCount: message.pieceCount,
      };
      if (store.recordLevelArrived(sid, rec) !== true) {
        throw new RecordRejectedError('recordLevelArrived', sid,
          `구간 ${rec.segmentId} 수준 ${rec.level} 창 ${rec.firstPieceSeq}..${rec.firstPieceSeq + rec.pieceCount - 1}`);
      }
    }
    send(bytes); // ③ 반환값은 보지 않는다. 던지면 그대로 전파
  };
}
