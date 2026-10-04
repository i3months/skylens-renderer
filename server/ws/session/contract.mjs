// ws 세션 배선 계약(T12.U, F-238 ④). 어댑터(server/adapter/core)·이어받기 저장소(server/ws/resume)·프레임 코덱(server/proto/codec)을
// 웹소켓 접속 객체(server/ws) 위에서 잇는다. 구현은 emit.mjs·resume.mjs·connection.mjs 가 나눠 맡는다.
//
// 규칙
//   emit 배선(emit.mjs): 어댑터의 emit(message) 마다 먼저 부호화하고, 저장소에 기록한 뒤 보낸다.
//     PIECE        : recordSent(sessionId, key, pieceSeq, chunk) 가 false 면 보내지 않고 던진다(상한·모르는 세션). true 면 send.
//     LEVEL_ARRIVED: recordLevelArrived(sessionId, {segmentId, level, firstPieceSeq, pieceCount}) 를 send 보다 먼저 부른다.
//                    false 면 보내지 않고 던진다. 기록 뒤 send 가 던지거나 false 를 돌려주면 던진다(어댑터가 같은 이벤트를 재시도하고
//                    저장소 기록은 멱등이다). 먼저 기록하는 이유: 기록 뒤 선에서 유실되면 이어받기 resendPlan 이 되살리고, 기록이 없으면 영구 pending.
//     MISSING      : 기록 없이 send.
//     send 함수는 던지는 것으로만 실패를 알린다(conn.send 의 false 는 소켓 배압 신호라 실패가 아니다). 반환값은 보지 않는다.
//   이어받기(resume.mjs): HELLO 를 받으면 store.open → WELCOME 을 보낸 뒤, resumed 이면 resendPlan(sessionId) 의 메시지를 순서대로 다시 보낸다.
//     PIECE 는 loadPiece(key) 가 돌려준 바이트를 chunk 로 붙이고, 바이트를 못 얻으면(null) 그 PIECE 와 그 창을 완료로 덮은 LEVEL_ARRIVED 는 보내지 않는다.
//     LEVEL_ARRIVED 는 저장소에 다시 기록하지 않아도 된다(멱등이라 해도 된다). resumed=false 면 재전송하지 않는다.
//   연결(connection.mjs): 접속 객체 하나를 받아 HELLO(첫 메시지)·ACK(store.ack)를 처리하고 닫힘을 알린다. 세션은 닫혀도 저장소에 남는다(이어받기).
//
// 타입은 contracts/proto 의 Message 와 같다. PIECE 는 { type:'PIECE', pieceSeq, key, chunk }.
/**
 * @typedef {import('../../../contracts/proto/index.mjs').Message} Message
 * @typedef {import('../../../contracts/proto/index.mjs').PieceKey} PieceKey
 * @typedef {{ open:Function, recordSent:Function, recordLevelArrived:Function, resendPlan:Function, ack:Function, shouldSend:Function }} SessionStoreLike
 *
 * createRecordingEmit({ store, sessionId, send, encode? }) -> (message: Message) => void
 *   sessionId: 정수 또는 () => 정수(HELLO 뒤에야 정해지는 경우). send: (bytes: Uint8Array) => unknown(던지면 실패). encode: 기본 server/proto/codec 의 encodeMessage.
 *
 * replayAfterHello({ store, hello, send, loadPiece, encode? }) -> { sessionId, resumed, nextPieceSeq, reason, replayed: number }
 *   hello: { sessionId, lastPieceSeq }. send: (bytes) => unknown. loadPiece: (key: PieceKey) => Uint8Array | null.
 *   WELCOME 을 보내고 재전송한 메시지 수(replayed)를 돌려준다.
 *
 * attachConnection({ conn, store, loadPiece, onSession?, encode?, decode? }) -> { emit: (message) => void, sessionId: () => number }
 *   conn: server/ws 접속 객체. 첫 메시지가 HELLO 가 아니면 ERROR BAD_MESSAGE 후 close(1002). emit 은 HELLO 처리 전에는 던진다.
 *   onSession(sessionId, {resumed}) 는 WELCOME 을 보낸 직후 한 번.
 */
export const SESSION_CONTRACT_VERSION = 1;
