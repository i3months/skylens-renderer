// ws 세션 배선 계약(T12.U, F-238 ④). 어댑터(server/adapter/core)·이어받기 저장소(server/ws/resume)·프레임 코덱(server/proto/codec)을
// 웹소켓 접속 객체(server/ws) 위에서 잇는다. 구현은 emit.mjs·resume.mjs·connection.mjs 가 나눠 맡는다.
//
// 규칙
//   emit 배선(emit.mjs): 어댑터의 emit(message) 마다 먼저 부호화하고, 저장소에 기록한 뒤 보낸다.
//     PIECE        : recordSent(sessionId, key, pieceSeq, chunk) 가 false 면 보내지 않고 던진다(상한·모르는 세션). true 면 send.
//     LEVEL_ARRIVED: recordLevelArrived(sessionId, {segmentId, level, firstPieceSeq, pieceCount}) 를 send 보다 먼저 부른다.
//                    false 면 보내지 않고 던진다. 기록 뒤 send 가 던지면 던진다(어댑터가 같은 이벤트를 재시도하고
//                    저장소 기록은 멱등이다). 먼저 기록하는 이유: 기록 뒤 선에서 유실되면 이어받기 resendPlan 이 되살리고, 기록이 없으면 영구 pending.
//     MISSING      : 기록 없이 send.
//     send 함수는 던지는 것으로만 실패를 알린다(conn.send 의 false 는 소켓 배압 신호라 실패가 아니다). 반환값은 보지 않는다.
//   이어받기(resume.mjs): HELLO 를 받으면 store.open → WELCOME 을 보낸 뒤, resumed 이면 resendPlan(sessionId) 의 메시지를 순서대로 다시 보낸다.
//     PIECE 는 loadPiece(key) 가 돌려준 바이트를 chunk 로 붙이고, 바이트를 못 얻으면(null) 거기서 재전송을 멈춘다(그 순번 뒤는 보내지 않고 LEVEL_ARRIVED 도 보내지 않는다. 반환의 stoppedAt 에 빠진 순번).
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
 * replayAfterHello({ store, hello, send, loadPiece, encode? }) -> { sessionId, resumed, nextPieceSeq, reason, replayed: number, stoppedAt: number|null, replayedBytes: number }
 *   hello: { sessionId, lastPieceSeq }. send: (bytes) => unknown. loadPiece: (key: PieceKey) => Uint8Array | null.
 *   WELCOME 을 보내고 재전송한 메시지 수(replayed)와 재전송한 메시지의 부호화 바이트 합(replayedBytes, WELCOME 은 제외)을 돌려준다. 재전송 중 loadPiece 가 바이트를 못 주면(null) 거기서 재전송을 멈춘다:
 *   그 순번 뒤는 보내지 않고 LEVEL_ARRIVED 도 보내지 않으며, 반환의 stoppedAt 에 빠진 순번이 들어 있다(멈춘 곳이 없으면 null).
 *
 * attachConnection({ conn, store, loadPiece, onSession?, onMessage?, onClose?, onStopped?, replay?, makeEmit?, encode?, decode? })
 *     -> { emit: (message) => void, sessionId: () => number }
 *   conn: server/ws 접속 객체. 첫 메시지가 HELLO 가 아니면 ERROR(BAD_MESSAGE) 후 close(1002). 둘째 HELLO 도 ERROR(BAD_MESSAGE) + close(1002).
 *   emit 은 HELLO 처리 전에는 던지고, 닫는 중에도 던진다. 첫 메시지 또는 HELLO 뒤에 복호가 실패해도 ERROR(BAD_MESSAGE) 후 close(1002).
 *   정지 정책: replayAfterHello 가 stoppedAt !== null 을 돌려주면 onSession·makeEmit 없이 ERROR(UNAVAILABLE) 후 close(1011) 로 닫고,
 *   이 연결에서는 생방송 송출을 허용하지 않는다(같은 연결에서 생방송이 이어지면 누적 ACK 가 빠진 조각과 그 창의 LEVEL_ARRIVED 기록을 지운다).
 *   대가: 영구히 못 얻는 바이트가 있으면 재접속해도 같은 멈춤이 반복되므로, 호출자가 그 세션을 닫고 새 세션으로 받게 해야 한다.
 *   정지 알림(F-279): 정지하면 close(1011, 'replay-stopped')(CLOSE_REASON_REPLAY_STOPPED) 로 닫는다. 그 밖의 1011(onSession·replay·
 *   onMessage 예외)은 사유 'internal-error'(CLOSE_REASON_INTERNAL) 다. 닫은 뒤 onStopped(sessionId, { stoppedAt }) 를 한 번 부르고,
 *   정지 뒤에도 api.sessionId() 는 값을 돌려준다. 호출자는 onStopped 에서 store.close(sessionId) 를 불러야 한다.
 *   방식 선택: attachConnection 이 store.close 를 직접 부르지 않고 알린다. 저장소 수명은 호출자가 쥐고(같은 세션을 다른
 *   접속이 쓰는지 등은 호출자만 안다), '연결은 세션을 지우지 않는다' 는 한 가지 규칙을 지킨다. 알리지 않으면 TTL 보다 짧은
 *   간격으로 같은 sessionId 를 HELLO 할 때마다 open 이 TTL 을 갱신해 세션이 만료되지 않고 정지가 끝없이 반복된다.
 *   onStopped 가 던지거나 거부해도 무시한다.
 *   클라이언트 규약: ERROR(UNAVAILABLE) 를 받으면(뒤이어 1011 'replay-stopped' 로 닫힌다) 같은 sessionId 로 다시 HELLO 하지
 *   않는다. HELLO{sessionId:0, lastPieceSeq:0} 으로 새 세션을 열어 처음부터 받는다. 같은 sessionId 로 다시 와도 서버가 세션을
 *   닫았으면 WELCOME{resumed:false}(저장소 reason 'UNKNOWN_SESSION')로 새 세션이 열린다.
 *   비동기 콜백(F-282): onSession 이 thenable 을 돌려주고 거부하면 동기 예외와 같이 close(1011, 'internal-error') 1회로 닫고 그 뒤
 *   emit 은 던진다(onSession 은 기다리지 않는다). onClose 의 반환은 Promise.resolve(r).catch(() => {}) 로 삼킨다.
 *   onSession(sessionId, { resumed, nextPieceSeq }) 는 WELCOME 과 재전송이 끝난 뒤 한 번(정지가 없을 때만) 불린다(WELCOME 직후가 아니다).
 *   어댑터는 이어받기 뒤 firstPieceSeq 를 nextPieceSeq 이상으로 만들어야 한다. 어기면 emit 이 minPieceSeq 하한으로 send 없이 던진다.
 *   createRecordingEmit 에는 minPieceSeq 옵션(정수 또는 함수)이 있다.
 */
export const SESSION_CONTRACT_VERSION = 1;
