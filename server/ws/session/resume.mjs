// 이어받기 재전송(T12.U 하위 작업 S2). 계약: ./contract.mjs, 저장소 규칙: server/ws/resume(F-236·F-241).
//   replayAfterHello({ store, hello, send, loadPiece, encode? }) -> { sessionId, resumed, nextPieceSeq, reason, replayed, replayedBytes, stoppedAt }
//
// 순서
//   1. store.open(hello) 로 세션을 열거나 이어받는다(값 검사·ack 반영은 저장소가 한다).
//   2. WELCOME {sessionId, resumed, nextPieceSeq} 를 부호화해 보낸다. reason 은 선에 싣지 않고 돌려주기만 한다
//      (UNKNOWN_SESSION 이면 호출자가 ERROR 를 낼지 고른다).
//   3. resumed 이면 store.resendPlan(sessionId) 의 메시지를 순서대로 다시 보낸다. resumed=false 면 재전송 0.
//      PIECE         : loadPiece(key) 의 바이트를 chunk 로 붙인다. null(또는 undefined)이면 그 순번에서 재전송을 멈춘다 —
//                      그 뒤의 PIECE·LEVEL_ARRIVED 는 보내지 않고 반환 stoppedAt 에 빠진 순번을 싣는다(없으면 null).
//      LEVEL_ARRIVED : 그대로 보낸다(멈추지 않았다면 창의 조각은 모두 보낸 뒤다. resendPlan 은 창의 마지막 조각 뒤에 둔다).
//   반환 replayed 는 실제 보낸 메시지 수(WELCOME 제외), replayedBytes 는 그 부호화 바이트 합. 상한 정합은 호출자가 판단한다.
//   저장소에는 아무것도 다시 기록하지 않는다(recordSent·recordLevelArrived 를 부르지 않는다). 그래서 재전송 도중 send 가
//   던져 예외가 전파돼도 저장소의 재전송 후보는 그대로이고, 같은 lastPieceSeq 로 다시 HELLO 하면 같은 재전송이 나간다.
//   send 의 반환값은 보지 않는다(실패는 던지는 것으로만 알린다. conn.send 의 false 는 배압 신호).
import { encodeMessage } from '../../proto/codec/index.mjs';

function needFn(v, name) {
  if (typeof v !== 'function') throw new TypeError(`${name} 는 함수여야 한다`);
}

/**
 * HELLO 를 처리해 WELCOME 을 보내고, 이어받기면 저장소의 재전송 계획을 보낸다.
 * @param {{ store: import('./contract.mjs').SessionStoreLike, hello: {sessionId:number, lastPieceSeq:number},
 *           send: (bytes: Uint8Array) => unknown, loadPiece: (key: import('./contract.mjs').PieceKey) => Uint8Array | null,
 *           encode?: (m: import('./contract.mjs').Message) => Uint8Array }} opts
 * @returns {{ sessionId:number, resumed:boolean, nextPieceSeq:number, reason:(string|null), replayed:number, replayedBytes:number, stoppedAt:(number|null) }}
 */
export function replayAfterHello({ store, hello, send, loadPiece, encode = encodeMessage } = {}) {
  if (store === null || typeof store !== 'object') throw new TypeError('store 가 필요하다');
  needFn(store.open, 'store.open');
  needFn(store.resendPlan, 'store.resendPlan');
  needFn(send, 'send');
  needFn(loadPiece, 'loadPiece');
  needFn(encode, 'encode');

  const { sessionId, resumed, nextPieceSeq, reason } = store.open(hello);
  send(encode({ type: 'WELCOME', sessionId, resumed, nextPieceSeq }));
  const result = { sessionId, resumed, nextPieceSeq, reason, replayed: 0, replayedBytes: 0, stoppedAt: null };
  if (!resumed) return result;

  // 첫 빠짐에서 재전송을 멈춘다: 클라이언트 ACK 는 누적(upToPieceSeq)이라 빠진 순번 뒤를 보내면 빠진 조각과 그 창의
  // LEVEL_ARRIVED 기록이 확인 처리로 영구히 지워진다. 멈추면 lastPieceSeq 가 빠진 순번 앞에 머물러 다음 이어받기에서 다시 후보가 된다.
  // 빠진 순번이 하나뿐이라 LEVEL_ARRIVED 창 판정은 필요 없다(앞 조각은 모두 보냈다). 전체가 O(N+L).
  for (const m of store.resendPlan(sessionId)) {
    let bytes;
    if (m.type === 'PIECE') {
      const chunk = loadPiece(m.key);
      if (chunk === null || chunk === undefined) { result.stoppedAt = m.pieceSeq; break; }
      bytes = encode({ type: 'PIECE', pieceSeq: m.pieceSeq, key: m.key, chunk });
    } else if (m.type === 'LEVEL_ARRIVED') {
      bytes = encode({ type: 'LEVEL_ARRIVED', segmentId: m.segmentId, level: m.level, pieceCount: m.pieceCount, firstPieceSeq: m.firstPieceSeq });
    } else {
      throw new TypeError(`resendPlan 의 모르는 메시지 종류: ${String(m?.type)}`);
    }
    send(bytes);
    result.replayed++;
    result.replayedBytes += bytes.length;
  }
  return result;
}
