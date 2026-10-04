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
//                  pieceSeq 하한(minPieceSeq, F-270): 하한 미만 pieceSeq 의 PIECE 는 이 emit 이 이미 보낸 같은 (seq, key)
//                  의 재시도가 아니면 기록·송출 없이 SeqFloorError 를 던진다. 저장소 recordSent 는 seq <= ackedUpTo 이고
//                  항목이 없으면 멱등 true 를 주므로(F-219 ③) 저장소만으로는 이어받기 전 연결이 쓴 순번의 재사용을 막지 못한다.
//                  재시도 판별용으로 이 emit 이 기록한 (seq, key) 를 Map 에 둔다(minPieceSeq 가 함수일 때만 — 정수 하한은
//                  바뀌지 않으므로 이 emit 이 보낸 순번은 언제나 하한 이상이다). 크기는 LEVEL_ARRIVED 송출이 끝나면 그 창
//                  끝 이하 항목을 지워 묶는다: 어댑터는 끝나지 않은 이벤트만 재시도하고, LEVEL_ARRIVED 는 이벤트의 마지막
//                  메시지라 그것이 나갔으면 그 창 이하 순번은 다시 오지 않는다.
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

/** 하한 미만 pieceSeq 를 새 key 로 쓰려 했을 때 던진다. 그 메시지는 기록·송출하지 않았다(F-270). */
export class SeqFloorError extends RangeError {
  /** @param {number} pieceSeq @param {number} floor */
  constructor(pieceSeq, floor) {
    super(`pieceSeq ${pieceSeq} 는 하한 ${floor} 미만이고 이 emit 이 같은 key 로 보낸 재시도가 아니다. 보내지 않았다`);
    this.name = 'SeqFloorError';
    this.code = 'SEQ_BELOW_FLOOR';
    this.pieceSeq = pieceSeq;
    this.floor = floor;
  }
}

/** PieceKey 를 비교용 문자열로(필드 순서 고정). */
function keyId(k) {
  return `${k.segmentId}/${k.level}/${k.lod}/${k.chunkIndex}/${k.tileX}/${k.tileY}`;
}

/**
 * @param {Object} options
 * @param {import('./contract.mjs').SessionStoreLike} options.store
 * @param {number | (() => number)} options.sessionId  정수 또는 메시지마다 부르는 함수(HELLO 뒤에야 정해지는 경우)
 * @param {(bytes: Uint8Array) => unknown} options.send  던지면 실패. 반환값은 보지 않는다
 * @param {(message: object) => Uint8Array} [options.encode]  기본 encodeMessage
 * @param {number | (() => number)} [options.minPieceSeq]  PIECE pieceSeq 하한. 정수 또는 PIECE 마다 부르는 함수. 없으면 검사 안 함
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
  const { minPieceSeq } = options;
  if (minPieceSeq !== undefined && typeof minPieceSeq !== 'function' && !Number.isInteger(minPieceSeq)) {
    throw new TypeError(`minPieceSeq 는 정수 또는 함수여야 한다: ${String(minPieceSeq)}`);
  }
  /** 이 emit 이 기록한 PIECE 의 pieceSeq → keyId. 하한이 함수(올라갈 수 있음)일 때만 쓴다. */
  const sentKeys = typeof minPieceSeq === 'function' ? new Map() : null;

  function currentFloor() {
    if (minPieceSeq === undefined) return null;
    const f = typeof minPieceSeq === 'function' ? minPieceSeq() : minPieceSeq;
    if (!Number.isInteger(f)) throw new TypeError(`minPieceSeq 가 정수가 아니다: ${String(f)}`);
    return f;
  }

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
      const floor = currentFloor();
      const id = keyId(message.key);
      if (floor !== null && message.pieceSeq < floor
        && !(sentKeys !== null && sentKeys.get(message.pieceSeq) === id)) {
        throw new SeqFloorError(message.pieceSeq, floor); // ② 전: 기록·송출 없음
      }
      if (store.recordSent(sid, message.key, message.pieceSeq, message.chunk) !== true) {
        throw new RecordRejectedError('recordSent', sid, `pieceSeq ${message.pieceSeq}`);
      }
      // 기록했으면 선에 나갔을 수 있다(send 가 던져도). 재시도를 알아보도록 남긴다.
      if (sentKeys !== null) sentKeys.set(message.pieceSeq, id);
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
    if (type === 'LEVEL_ARRIVED' && sentKeys !== null && sentKeys.size > 0) {
      // 이벤트가 끝났다: 그 창 끝 이하 순번은 재시도로 다시 오지 않는다.
      // Map 은 순번 오름차순으로 삽입된다(새 순번은 언제나 앞 순번보다 크고, 재시도의 set 은 기존 자리를 유지한다).
      // 그래서 첫 seq > last 에서 멈춘다 — LEVEL_ARRIVED 마다 Map 전체를 돌지 않는다(F-277 ④).
      const last = message.firstPieceSeq + message.pieceCount - 1;
      for (const seq of sentKeys.keys()) {
        if (seq > last) break;
        sentKeys.delete(seq);
      }
    }
  };
}
