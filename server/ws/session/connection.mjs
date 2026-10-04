// 접속 배선(T12.U S4). 접속 객체 하나를 받아 HELLO(첫 메시지)·ACK 를 처리하고 닫힘을 알린다. 계약: ./contract.mjs
// 세션은 접속이 닫혀도 저장소에 남는다(이어받기). 그래서 닫힘에서 store.close 를 부르지 않는다.
// 재전송 정지 정책(F-275, 정책 (a)): replay 가 loadPiece 로 바이트를 얻지 못해 재전송을 멈추면(stoppedAt !== null)
//   이 접속에서는 생방송 송출을 허용하지 않는다. onSession·makeEmit 을 부르지 않고 ERROR(UNAVAILABLE) 를 보낸 뒤
//   close(1011) 로 닫는다. 반환 api 의 emit 은 닫는 중과 같이 던진다. 세션은 저장소에서 지우지 않는다(호출자 판단).
//   근거: 같은 접속에서 생방송이 이어져 클라이언트가 빠진 순번 너머를 ACK 하면, 누적 ACK 가 ackedUpTo 를 빠진 순번 너머로
//   올려 빠진 조각과 그 창의 LEVEL_ARRIVED 기록, 뒤의 재전송 후보가 영구히 지워진다.
//   대가: 영구히 얻을 수 없는 바이트가 있으면 재접속해도 같은 정지가 반복된다. 호출자는 그 세션을 닫고(store.close)
//   클라이언트가 새 세션을 열게 해야 한다(이후 새로 도착하는 것만 받는다, contract.mjs 참조).
// 정지 알림(F-279): 정지하면 close(1011, 'replay-stopped') 로 닫아 다른 1011('internal-error')과 사유 문자열로 구별하고,
//   onStopped(sessionId, { stoppedAt }) 를 한 번 부른다. 정지 뒤에도 api.sessionId() 는 값을 돌려준다.
//   store.close 는 여기서 부르지 않는다(세션을 지울지는 호출자 판단, 위 정책 유지). 호출자는 onStopped 에서 store.close 한다.
// 비동기 콜백(F-282): onSession 이 thenable 을 돌려주고 거부하면 동기 예외와 같이 close(1011) 로 닫는다(기다리지는 않는다).
//   onClose·onStopped 의 거부는 삼킨다(이미 닫는 중).
// 정지 판별(F-285): 서버 쪽 정지 판별은 onStopped 로만 한다. onClose 의 reason 은 믿지 않는다(실제 서버는 피어 close 에코가
//   reason 을 덮어 {code:1011, reason:""} 로 알린다). onStopped 와 onClose 의 호출 순서는 보장하지 않는다
//   (닫힌 뒤 replay 가 정지를 보고하면 onClose 가 먼저 오고, 정지 중 닫으면 close 에코에 따라 어느 쪽이 먼저일 수 있다).
// stoppedAt 은 정수일 때만 정지다. 그 밖의 값(NaN·문자열 등, null·undefined 제외)은 내부 오류 1011 'internal-error' 로 닫는다.
// onSession 미호출 조건(F-281): 재전송 정지(replay 가 stoppedAt 을 돌려줄 때), replay 중 접속이 닫힌 경우, replay·onSession 예외.
//   replay 중 닫혔는데 replay 가 정지를 보고했다면 onSession 은 부르지 않지만 onStopped 는 부른다(sessionId() 도 값을 돌려준다).
import { decodeMessage, encodeMessage } from '../../proto/codec/index.mjs';
import { ERR_CODES } from '../../../contracts/proto/index.mjs';
import { createRecordingEmit } from './emit.mjs';
import { replayAfterHello } from './resume.mjs';

const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_INTERNAL_ERROR = 1011;
// 1011 의 사유 문자열: 재전송 정지와 그 밖의 내부 오류를 구별한다(F-279).
export const CLOSE_REASON_REPLAY_STOPPED = 'replay-stopped';
export const CLOSE_REASON_INTERNAL = 'internal-error';

const isThenable = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
// 알림 콜백의 동기 예외·비동기 거부를 삼킨다.
function notifyQuietly(fn, ...args) {
  try {
    const r = fn(...args);
    if (isThenable(r)) Promise.resolve(r).catch(() => {});
  } catch { /* 알림 실패는 무시 */ }
}

/**
 * @param {object} o
 * @param {{send:Function,onMessage:Function,onClose:Function,close:Function,bufferedAmount?:Function}} o.conn 접속 객체
 * @param {object} o.store 이어받기 저장소(ack 를 쓴다)
 * @param {Function} o.loadPiece (key) => Uint8Array | null
 * @param {(sessionId:number, info:{resumed:boolean,nextPieceSeq:number}) => void} [o.onSession] WELCOME 과 재전송이 끝난 뒤 한 번
 *   (재전송 정지가 없을 때만 — 정지하면 부르지 않는다, F-275. replay 중 접속이 닫힌 경우도 부르지 않는다, F-281).
 *   thenable 을 돌려주고 거부하면 close(1011, 'internal-error') 로 닫는다(F-282).
 *   nextPieceSeq 는 store.open 이 돌려준 값이다. 이 접속에서 새로 매길 pieceSeq 는 이 값 이상이어야 한다(F-270) —
 *   어댑터를 만들 때 firstPieceSeq 로 넘긴다. emit 도 이 값을 하한(minPieceSeq)으로 검사한다.
 * @param {(message:object) => unknown} [o.onMessage] HELLO 뒤 ACK 외의 클라이언트 메시지(기본은 무시)
 * @param {(info:{code:number,reason:string}) => void} [o.onClose] 접속이 닫혔을 때(던지거나 거부해도 무시)
 * @param {(sessionId:number, info:{stoppedAt:number}) => void} [o.onStopped] 재전송 정지로 닫을 때 한 번(F-279).
 *   ERROR(UNAVAILABLE) 와 close(1011, 'replay-stopped') 뒤에 부른다. 호출자는 여기서 store.close(sessionId) 해야 한다.
 *   replay 중 접속이 이미 닫혔는데 replay 가 정지를 보고해도 부른다(ERROR·close 없이). onClose 와의 순서는 보장하지 않고,
 *   서버 쪽 정지 판별은 onClose reason 이 아니라 onStopped 로만 한다(F-285).
 * @param {Function} [o.encode] 기본 encodeMessage
 * @param {Function} [o.decode] 기본 decodeMessage
 * @param {Function} [o.replay] 기본 replayAfterHello
 * @param {Function} [o.makeEmit] 기본 createRecordingEmit
 * @returns {{emit:(message:object)=>void, sessionId:()=>number}}
 *   sessionId() 는 HELLO 처리(replay) 전에는 던지고, 그 뒤에는 재전송 정지로 닫혔어도 값을 돌려준다(F-279).
 *   emit 은 HELLO 처리 전이거나 접속이 닫히는 중(닫힘·close 호출 뒤, onSession·replay 예외의 close(1011), 재전송 정지의
 *   close(1011) 포함)이면 보내지 않고 던진다(F-270 ③, F-274 ①, F-275).
 *   HELLO 뒤 메시지의 복호가 실패하거나 null 이면 ERROR(BAD_MESSAGE) + close(1002) 로 닫는다(F-277 ②).
 *   둘째 HELLO 는 프로토콜 위반으로 ERROR(BAD_MESSAGE) + close(1002) 로 거부한다(F-274 ⑦).
 */
export function attachConnection({
  conn, store, loadPiece, onSession, onMessage, onClose, onStopped,
  encode = encodeMessage, decode = decodeMessage,
  replay = replayAfterHello, makeEmit = createRecordingEmit,
}) {
  let sessionId = 0;
  let sessionKnown = false;
  let emitFn = null;
  let helloSeen = false;
  let closing = false;
  let chain = Promise.resolve();

  const send = (bytes) => conn.send(bytes);
  const closeWith = (code, reason) => {
    if (closing) return;
    closing = true;
    try { conn.close(code, reason); } catch { /* 이미 닫힘 */ }
  };
  const internalError = () => closeWith(CLOSE_INTERNAL_ERROR, CLOSE_REASON_INTERNAL);
  const protocolError = (text) => {
    if (closing) return;
    try { conn.send(encode({ type: 'ERROR', code: ERR_CODES.BAD_MESSAGE, text })); } catch { /* 보내지 못해도 닫는다 */ }
    closeWith(CLOSE_PROTOCOL_ERROR);
  };

  async function handleHello(hello) {
    try {
      const result = await replay({ store, hello, send, loadPiece, encode });
      sessionId = result.sessionId;
      sessionKnown = true;
      // replay 를 기다리는 동안 접속이 닫혔으면 송출 배선을 만들지 않는다(F-277 ①). 다만 replay 가 정지를 보고했다면
      // 닫힌 뒤여도 호출자가 세션을 닫을 수 있게 onStopped 는 부른다(F-285 ③; ERROR·close 는 이미 닫혀 보내지 않는다).
      const noStop = result.stoppedAt === null || result.stoppedAt === undefined;
      if (closing) {
        if (Number.isInteger(result.stoppedAt) && onStopped) {
          notifyQuietly(onStopped, sessionId, { stoppedAt: result.stoppedAt });
        }
        return;
      }
      // 정지는 정수 stoppedAt 만이다. NaN·문자열 같은 값은 정지로 보지 않고 내부 오류(1011 'internal-error')로 닫는다.
      if (!noStop && !Number.isInteger(result.stoppedAt)) {
        internalError();
        return;
      }
      if (!noStop) {
        // 재전송 정지: 이 접속에서는 생방송을 허용하지 않는다(F-275, 머리 주석의 정책 (a)). emitFn 은 null 로 남는다.
        try {
          conn.send(encode({ type: 'ERROR', code: ERR_CODES.UNAVAILABLE, text: `조각 ${result.stoppedAt} 의 바이트가 없어 재전송을 멈췄다` }));
        } catch { /* 보내지 못해도 닫는다 */ }
        closeWith(CLOSE_INTERNAL_ERROR, CLOSE_REASON_REPLAY_STOPPED);
        // 호출자가 세션을 닫을 수 있게 sessionId·stoppedAt 을 알린다(F-279).
        if (onStopped) notifyQuietly(onStopped, sessionId, { stoppedAt: result.stoppedAt });
        return;
      }
      // 이어받기 전 연결이 이미 쓴 순번을 새 key 로 다시 쓰지 않게 open 의 nextPieceSeq 를 하한으로 준다(F-270).
      emitFn = makeEmit({ store, sessionId, send, encode, minPieceSeq: result.nextPieceSeq });
      if (onSession) {
        const r = onSession(sessionId, { resumed: result.resumed, nextPieceSeq: result.nextPieceSeq });
        // 비동기 onSession 의 거부도 동기 예외와 같이 닫는다. 기다리지 않는다(뒤 메시지 처리를 막지 않게, F-282).
        if (isThenable(r)) Promise.resolve(r).catch(internalError);
      }
    } catch {
      internalError();
    }
  }

  async function handle(bytes) {
    if (closing) return;
    let message;
    try { message = decode(bytes); } catch { return protocolError('복호 실패'); }
    if (!helloSeen) {
      if (!message || message.type !== 'HELLO') return protocolError('첫 메시지는 HELLO 여야 함');
      helloSeen = true;
      return handleHello(message);
    }
    // 복호 결과가 null 이면 클라이언트의 잘못된 메시지다(내부 오류 1011 이 아니다, F-277 ②).
    if (!message || typeof message !== 'object') return protocolError('복호 결과 없음');
    // 둘째 HELLO 는 세션을 바꿀 수 없다. 조용히 무시하면 클라이언트가 이어받기됐다고 오해하므로 거부한다(F-274 ⑦).
    if (message.type === 'HELLO') return protocolError('HELLO 는 접속당 한 번');
    if (!emitFn) return; // 이어받기 처리 중이던 replay 가 실패해 닫는 중
    try {
      if (message.type === 'ACK') store.ack(sessionId, message.upToPieceSeq);
      else if (onMessage) await onMessage(message);
    } catch {
      internalError();
    }
  }

  // 메시지는 도착 순서대로 하나씩 처리한다(replay 가 끝나기 전의 ACK 는 그 뒤에 처리).
  conn.onMessage((bytes) => {
    chain = chain.then(() => handle(bytes));
    return chain;
  });
  let closeNotified = false;
  conn.onClose((info) => {
    closing = true;
    if (closeNotified) return; // conn 이 closeCb 를 두 번 불러도 onClose 는 한 번
    closeNotified = true;
    if (onClose) notifyQuietly(onClose, info);
  });

  return {
    emit(message) {
      // 닫는 중이면 보내지 않는다(onSession 이 던져 close(1011) 한 뒤에도 계속 송출하지 않게, F-274 ①).
      // 재전송 정지로 닫는 중이면 emitFn 이 없으므로 이 판정을 먼저 한다(F-275).
      if (closing) throw new Error('접속이 닫히는 중이라 emit 할 수 없음');
      if (!emitFn) throw new Error('HELLO 처리 전에는 emit 할 수 없음');
      emitFn(message);
    },
    // 재전송 정지 뒤에도 값을 돌려준다(F-279). emitFn 이 없어도 replay 가 sessionId 를 정했으면 된다.
    sessionId: () => {
      if (!sessionKnown) throw new Error('HELLO 처리 전에는 sessionId 가 없음');
      return sessionId;
    },
  };
}
