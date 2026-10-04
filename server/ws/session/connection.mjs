// 접속 배선(T12.U S4). 접속 객체 하나를 받아 HELLO(첫 메시지)·ACK 를 처리하고 닫힘을 알린다. 계약: ./contract.mjs
// 세션은 접속이 닫혀도 저장소에 남는다(이어받기). 그래서 닫힘에서 store.close 를 부르지 않는다.
import { decodeMessage, encodeMessage } from '../../proto/codec/index.mjs';
import { ERR_CODES } from '../../../contracts/proto/index.mjs';
import { createRecordingEmit } from './emit.mjs';
import { replayAfterHello } from './resume.mjs';

const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_INTERNAL_ERROR = 1011;

/**
 * @param {object} o
 * @param {{send:Function,onMessage:Function,onClose:Function,close:Function,bufferedAmount?:Function}} o.conn 접속 객체
 * @param {object} o.store 이어받기 저장소(ack 를 쓴다)
 * @param {Function} o.loadPiece (key) => Uint8Array | null
 * @param {(sessionId:number, info:{resumed:boolean,nextPieceSeq:number}) => void} [o.onSession] WELCOME 직후 한 번.
 *   nextPieceSeq 는 store.open 이 돌려준 값이다. 이 접속에서 새로 매길 pieceSeq 는 이 값 이상이어야 한다(F-270) —
 *   어댑터를 만들 때 firstPieceSeq 로 넘긴다. emit 도 이 값을 하한(minPieceSeq)으로 검사한다.
 * @param {(message:object) => unknown} [o.onMessage] HELLO 뒤 ACK 외의 클라이언트 메시지(기본은 무시)
 * @param {(info:{code:number,reason:string}) => void} [o.onClose] 접속이 닫혔을 때
 * @param {Function} [o.encode] 기본 encodeMessage
 * @param {Function} [o.decode] 기본 decodeMessage
 * @param {Function} [o.replay] 기본 replayAfterHello
 * @param {Function} [o.makeEmit] 기본 createRecordingEmit
 * @returns {{emit:(message:object)=>void, sessionId:()=>number}}
 *   emit 은 HELLO 처리 전이거나 접속이 닫히는 중(닫힘·close 호출 뒤, onSession·replay 예외의 close(1011) 포함)이면
 *   보내지 않고 던진다(F-270 ③, F-274 ①).
 *   둘째 HELLO 는 프로토콜 위반으로 ERROR(BAD_MESSAGE) + close(1002) 로 거부한다(F-274 ⑦).
 */
export function attachConnection({
  conn, store, loadPiece, onSession, onMessage, onClose,
  encode = encodeMessage, decode = decodeMessage,
  replay = replayAfterHello, makeEmit = createRecordingEmit,
}) {
  let sessionId = 0;
  let emitFn = null;
  let helloSeen = false;
  let closing = false;
  let chain = Promise.resolve();

  const send = (bytes) => conn.send(bytes);
  const closeWith = (code) => {
    if (closing) return;
    closing = true;
    try { conn.close(code); } catch { /* 이미 닫힘 */ }
  };
  const protocolError = (text) => {
    if (closing) return;
    try { conn.send(encode({ type: 'ERROR', code: ERR_CODES.BAD_MESSAGE, text })); } catch { /* 보내지 못해도 닫는다 */ }
    closeWith(CLOSE_PROTOCOL_ERROR);
  };

  async function handleHello(hello) {
    try {
      const result = await replay({ store, hello, send, loadPiece, encode });
      sessionId = result.sessionId;
      // 이어받기 전 연결이 이미 쓴 순번을 새 key 로 다시 쓰지 않게 open 의 nextPieceSeq 를 하한으로 준다(F-270).
      emitFn = makeEmit({ store, sessionId, send, encode, minPieceSeq: result.nextPieceSeq });
      if (onSession) onSession(sessionId, { resumed: result.resumed, nextPieceSeq: result.nextPieceSeq });
    } catch {
      closeWith(CLOSE_INTERNAL_ERROR);
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
    // 둘째 HELLO 는 세션을 바꿀 수 없다. 조용히 무시하면 클라이언트가 이어받기됐다고 오해하므로 거부한다(F-274 ⑦).
    if (message && message.type === 'HELLO') return protocolError('HELLO 는 접속당 한 번');
    if (!emitFn) return; // 이어받기 처리 중이던 replay 가 실패해 닫는 중
    try {
      if (message.type === 'ACK') store.ack(sessionId, message.upToPieceSeq);
      else if (onMessage) await onMessage(message);
    } catch {
      closeWith(CLOSE_INTERNAL_ERROR);
    }
  }

  // 메시지는 도착 순서대로 하나씩 처리한다(replay 가 끝나기 전의 ACK 는 그 뒤에 처리).
  conn.onMessage((bytes) => {
    chain = chain.then(() => handle(bytes));
    return chain;
  });
  conn.onClose((info) => {
    closing = true;
    if (onClose) { try { onClose(info); } catch { /* 알림 실패는 무시 */ } }
  });

  return {
    emit(message) {
      if (!emitFn) throw new Error('HELLO 처리 전에는 emit 할 수 없음');
      // 닫는 중이면 보내지 않는다(onSession 이 던져 close(1011) 한 뒤에도 계속 송출하지 않게, F-274 ①).
      if (closing) throw new Error('접속이 닫히는 중이라 emit 할 수 없음');
      emitFn(message);
    },
    sessionId: () => {
      if (!emitFn) throw new Error('HELLO 처리 전에는 sessionId 가 없음');
      return sessionId;
    },
  };
}
