// 이어받기 재전송(T12.U 하위 작업 S2). 계약: ./contract.mjs, 저장소 규칙: server/ws/resume(F-236·F-241).
//   replayAfterHello({ store, hello, send, loadPiece, encode? }) -> { sessionId, resumed, nextPieceSeq, reason, replayed }
//
// 순서
//   1. store.open(hello) 로 세션을 열거나 이어받는다(값 검사·ack 반영은 저장소가 한다).
//   2. WELCOME {sessionId, resumed, nextPieceSeq} 를 부호화해 보낸다. reason 은 선에 싣지 않고 돌려주기만 한다
//      (UNKNOWN_SESSION 이면 호출자가 ERROR 를 낼지 고른다).
//   3. resumed 이면 store.resendPlan(sessionId) 의 메시지를 순서대로 다시 보낸다. resumed=false 면 재전송 0.
//      PIECE         : loadPiece(key) 의 바이트를 chunk 로 붙인다. null(또는 undefined)이면 보내지 않고 그 순번을 '빠짐'으로 둔다.
//      LEVEL_ARRIVED : 창 firstPieceSeq..firstPieceSeq+pieceCount−1 에 빠진 순번이 하나라도 있으면 보내지 않는다 — 클라이언트
//                      (contracts/client_raster/arrival.mjs)는 창의 조각을 모두 받아야 완료로 세고, 모자라면 거부하기 때문이다.
//                      resendPlan 은 LEVEL_ARRIVED 를 자기 창의 마지막 조각 뒤에 두므로, 창 안 PIECE 는 이미 판정을 마쳤다.
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
 * @returns {{ sessionId:number, resumed:boolean, nextPieceSeq:number, reason:(string|null), replayed:number }}
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
  const result = { sessionId, resumed, nextPieceSeq, reason, replayed: 0 };
  if (!resumed) return result;

  const missing = []; // 바이트를 못 얻어 보내지 않은 PIECE 순번(오름차순)
  for (const m of store.resendPlan(sessionId)) {
    if (m.type === 'PIECE') {
      const chunk = loadPiece(m.key);
      if (chunk === null || chunk === undefined) { missing.push(m.pieceSeq); continue; }
      send(encode({ type: 'PIECE', pieceSeq: m.pieceSeq, key: m.key, chunk }));
    } else if (m.type === 'LEVEL_ARRIVED') {
      const first = m.firstPieceSeq;
      const last = first + m.pieceCount - 1;
      if (missing.some((s) => s >= first && s <= last)) continue; // 창의 조각이 빠졌다: 완료 표시를 보내지 않는다
      send(encode({ type: 'LEVEL_ARRIVED', segmentId: m.segmentId, level: m.level, pieceCount: m.pieceCount, firstPieceSeq: first }));
    } else {
      throw new TypeError(`resendPlan 의 모르는 메시지 종류: ${String(m?.type)}`);
    }
    result.replayed++;
  }
  return result;
}
