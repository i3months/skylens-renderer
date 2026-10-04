// skylens 코어 이벤트 어댑터(T11.8). 계약: contracts/proto/index.mjs, contracts/levels/index.mjs, contracts/asset/index.mjs
//
// 가정(skylens 코어 원본 코드는 이 환경에서 열람할 수 없어 아래 모양을 가정하고 여기에 고정한다):
//   코어는 구간 하나가 "올 예정" 이 되었을 때 segment_expected 를, 그 구간의 딜레이 패턴 수준 하나가 다 만들어졌을 때
//   level_arrived 를 동기 호출로 내보낸다. 한 level_arrived 는 그 수준의 조각 전부를 담는다(조각을 나눠 보내지 않는다).
//   같은 (구간, 수준) 이 두 번 올 수도 있고(중복), 높은 수준 뒤에 낮은 수준이 늦게 올 수도 있다(추월).
//   조각 bytes 는 contracts/asset 의 .skla 조각 그대로이고, 어댑터는 그 내용을 해석하지 않는다.
//
// 동작:
//   segment_expected → machine.expect(segmentId). 그 뒤에도 구간이 "없음" 이면 MISSING 한 건을 내보낸다.
//     이미 수준이 도착한 구간이면 아무것도 내보내지 않는다(도착한 구간을 없음이라 거짓으로 알리지 않는다).
//   level_arrived → machine.arrive(segmentId, level, pieces).
//     skip(추월·중복)      : 아무것도 내보내지 않는다.
//     first / replace      : 조각마다 PIECE 한 건(pieceSeq 는 어댑터가 PIECE_SEQ_MIN(1)부터 1씩 올리는 u32), 그다음 LEVEL_ARRIVED 한 건.
//                            순서는 PIECE 들이 먼저이고 LEVEL_ARRIVED 가 마지막이다. 받는 쪽은 LEVEL_ARRIVED 를 "그 수준의
//                            조각 pieceCount 개가 모두 왔다" 는 완료 표시로 쓰고, 그때 자기 수준 기계에 arrive 한다.
//                            완료 표시 없이 조각만 온 것은 수준 도착으로 세지 않고 버린다(실패한 송출의 조각이 그런 경우).
//                            LEVEL_ARRIVED 가 선에 쓰였으면(그 뒤 emit 이 던졌어도) 받는 쪽은 그 수준을 완료로 센다(F-235).
//     실패 뒤 재시도가 skip 이 되면(그 사이 같거나 높은 수준이 도착) 끝나지 않은 표시를 지우고, 쓰였을 수 있는 pieceSeq 는
//     태운다. 실패한 시도들이 LEVEL_ARRIVED emit 까지 가지 않았으면 부분 송출된 key 는 완료 표시가 없으므로
//     onRelease(keys, {abandoned:true}) 로 놓는다(결과의 abandoned 에도 key 가 담긴다). 어느 시도든 LEVEL_ARRIVED emit 을
//     불렀으면(F-235) 그 LEVEL_ARRIVED 가 쓰였을 수 있다 — 쓰였으면 받는 쪽은 완료로 세어 그 key 를 그리므로 어댑터는 그
//     key 를 놓으라고 알리지 않는다: abandoned 는 [] 이고 결과에 levelArrivedMaybeSent: true 가 붙는다(onRelease 없음).
//     쓰이지 않았다면 받는 쪽은 완료 표시 없는 조각을 스스로 버린다(pending → 수준 교체 때 discard).
//     replace              : 기계가 released 로 내보낸 이전 수준 조각의 key 목록을 onRelease(keys, info) 로 알린다.
//   onRelease 계약: info 는 {segmentId, level, previousLevel} 이고, skip 의 부분 송출 해제에는 abandoned:true 가 더 붙는다.
//     받는 쪽은 같은 key 의 중복 해제를 견뎌야 한다(이미 놓은 key 를 또 놓으라는 알림은 아무 일도 하지 않아야 한다).
//     알림이 실패해 다시 알리는 경우(아래 재통지)와 onRelease 여럿 중 일부만 던진 경우에 같은 key 가 두 번 올 수 있다.
//   재진입(F-231 ⑥): onRelease 안에서 같은 어댑터의 handle() 을 불러도 된다. 안쪽(깊이 1 이상) handle 은 보관한 알림을
//     재통지하지 않고(지금 알리는 중인 항목을 다시 알리면 무한 재귀가 된다) 결과에 releaseDropped 를 싣지 않는다 — 재통지와
//     releaseDropped 는 바깥(깊이 0) handle 만 한다. 그래서 재진입 onRelease 하나의 알림 횟수는 재진입이 없을 때와 같다.
//   재통지(F-229 ②, F-231): skip(abandoned)·replace 의 onRelease 가 던지면 그 알림을 보관하고 예외를 그대로 던진다.
//     이후 바깥 handle() 호출마다 이벤트를 처리하기 전에 보관한 알림을 다시 알린다. 재통지의 실패는 삼키고(이벤트는 언제나 처리된다
//     — 계속 던지는 onRelease 하나가 어댑터를 영구히 멈추게 하지 않도록), 재통지 횟수가 releaseRetryLimit(기본
//     RELEASE_RETRY_LIMIT)에 닿으면 그 알림을 버리고 그다음 돌려주는 바깥 결과의 releaseDropped 에 {keys, info, error}
//     (사본)로 싣는다.
//     재통지 때는 기계를 다시 보고, 기계의 현재 수준이 그 key 의 수준과 같고 그 key 를 쥐고 있으면(그 사이 같은 수준·같은
//     key 가 확정돼 지금 그려지는 조각) 그 key 는 알리지 않는다. 남은 key 가 없으면 알림을 끝난 것으로 지운다.
//   송출과 상태 확정 순서(F-189):
//     ① 기계 snapshot 과 decideArrival 로 결정을 미리 본다(skip 이면 끝). ② 보낼 메시지를 모두 만들고 부호화까지 마친다.
//     ③ 전부 emit 한다. ④ 그다음에야 nextSeq 를 올리고 machine.arrive 로 상태를 확정한다. ⑤ onRelease 를 부른다.
//     ② 에서 던지면(부호화 실패) 아무것도 나가지 않았으므로 기계 상태·nextSeq 는 그대로이고 예외를 다시 던진다.
//     ③ 에서 던지면 기계 상태·nextSeq 는 그대로이고, 어댑터는 그 이벤트를 "끝나지 않은 이벤트" 로 기억한 채 예외를 다시
//     던진다(F-204). emit 이 던졌을 때 그 메시지가 실제로 쓰였는지(이어받기 저장소에 기록됐는지) 어댑터는 알 수 없으므로,
//     실패한 시도가 매긴 pieceSeq 는 모두 "그 key 로 이미 쓰였을 수 있는 순번" 으로 본다.
//     규칙: 한 pieceSeq 는 절대 서로 다른 두 key 에 쓰이지 않는다(contracts/proto 재전송 규약).
//     그래서 끝나지 않은 이벤트가 있는 동안 그것과 다른 이벤트(다른 level_arrived, segment_expected 모두)는 아무것도 내보내지
//     않고 UnfinishedEventError(code 'UNFINISHED_EVENT')로 거부한다(상태·순번 그대로). 복구는 같은 이벤트(같은 구간·수준,
//     같은 순서의 같은 조각 key·같은 bytes)를 다시 넣는 것뿐이다. 그러면 결정이 그대로 first/replace 로 나오고, 실패한
//     시도가 쓰려던 pieceSeq 부터 같은 key 로 다시 매긴다(끊김 없음). 이미 나간 emit 은 같은 pieceSeq·key 로 다시 나가므로
//     받는 쪽은 그것을 같은 조각으로 다룬다. 재시도가 ③ 을 다 마치면 끝나지 않은 이벤트 표시가 지워진다.
//     이어받기 저장소(server/ws/resume)의 recordSent 는 같은 key·같은 seq 재기록을 멱등으로 받으므로(F-197) emit 안에서
//     recordSent 를 불러도 재시도가 막히지 않는다. 실패한 시도 사이에 ack·축출로 그 항목이 지워졌어도(seq <= ackedUpTo)
//     recordSent 는 멱등 true 다(F-219 ③).
//     "같은 bytes" 는 실패한 시도 때의 내용이다. 어댑터는 실패 시점의 bytes 를 실제로 복사해 둔다(new Uint8Array,
//     F-219 ①) — Buffer.prototype.slice 는 뷰라서 호출자가 원본(pool Buffer 등)을 덮어쓰면 재시도가 내용이 다른 조각을
//     같은 pieceSeq·key 로 보내게 된다. 원본이 바뀐 재시도는 다른 이벤트로 보고 UnfinishedEventError 로 거부한다.
//     재시도 때 수준 기계가 외부에서(어댑터를 거치지 않고) 진행돼 결정이 skip 이 되면(F-219 ②): 그 이벤트를 다시 보낼
//     일이 없으므로 아무것도 내보내지 않고, 실패한 시도에 묶였던 pieceSeq 들(firstPieceSeq..+pieceCount-1)을 소비한 것으로
//     확정하고(nextSeq 를 그만큼 올림) 끝나지 않은 표시를 지운 뒤 action 'skip' 을 돌려준다. 순번을 다시 쓰지 않으므로
//     한 pieceSeq 가 두 key 에 쓰이는 일은 없다. 대가: 그 순번 중 일부는 선에 나갔을 수도, 안 나갔을 수도 있고(순번에
//     빈칸이 생길 수 있음), 이 재시도는 LEVEL_ARRIVED 를 내보내지 않는다. 받는 쪽은 완료 표시 없는 조각을 수준 도착으로
//     세지 않는다. 실패한 시도가 LEVEL_ARRIVED 를 이미 썼다면 받는 쪽은 그 수준을 완료로 센다 — 어댑터는 emit 을 불렀는지만
//     알 수 있으므로 그 경우 levelArrivedMaybeSent 로 표시하고 그 key 를 놓으라고 알리지 않는다(위 skip 규칙, F-235).
//     재시도가 영구히 실패할 때의 복구(F-219 ④): 어댑터 하나로는 풀 수 없다(같은 이벤트 재시도 말고는 모두 거부).
//     호출자는 그 어댑터를 버리고 새로 만든다. 새 어댑터의 firstPieceSeq 는 옛 어댑터가 썼을 수 있는 모든 순번보다 커야
//     한다: unfinishedEvent() 의 firstPieceSeq + pieceCount(또는 이어받기 저장소를 쓰면 open 이 돌려주는 nextPieceSeq 중
//     큰 값). 수준 기계도 새로(또는 옛 기계 그대로 — 실패한 이벤트는 기계에 확정되지 않았다) 넘긴다. 연결이 끊긴 경우라면
//     클라이언트는 HELLO 이어받기로 남은 조각을 다시 받고, 이어받을 수 없으면 새 세션으로 처음부터 받는다.
//     ⑤ 는 상태 확정 뒤라 실패해도 되돌리지 않는다(메시지는 이미 다 나갔다). onRelease 는 함수 또는 함수 배열이며,
//     하나가 던져도 나머지를 모두 부른 다음 예외를 다시 던진다(하나면 그 예외, 둘 이상이면 AggregateError).
//   도착하지 않은 것을 만들거나 메우지 않는다. 시간·타이머를 쓰지 않는다. 상태는 handle 호출로만 바뀐다.
// 입력 검사: 이벤트 전체를 기계에 넘기기 전에 검사한다(검사 실패 시 상태·순번은 그대로).
//   level_arrived 의 pieces 는 1 개 이상이어야 한다(F-203 ①). 빈 수준 도착은 RangeError 로 거부하고 이전 수준을 그대로
//   둔다 — 빈 수준이 replace 로 이미 그린 조각을 모두 놓게 하거나 pieceCount 0 LEVEL_ARRIVED 를 내보내지 않는다.
//   모양이 틀리면 TypeError, 값이 범위 밖이면 RangeError.
import { createLevelMachine } from '../../levels/state/index.mjs';
import { LEVEL_COUNT, ACTIONS, decideArrival } from '../../../contracts/levels/index.mjs';
import { SEGMENT_ID_LIMIT, LOD_MAX } from '../../../contracts/asset/index.mjs';
import { MAX_PAYLOAD_BYTES, PIECE_KEY_BYTES, PIECE_SEQ_MIN, pieceKeyString } from '../../../contracts/proto/index.mjs';

/** PIECE 본문에서 조각 바이트 앞에 오는 부분(pieceSeq u32 + PieceKey). */
const PIECE_PREFIX_BYTES = 4 + PIECE_KEY_BYTES;
/** 조각 하나의 최대 바이트(프레임 본문 상한에서 PIECE 앞부분을 뺀 값). */
export const MAX_PIECE_BYTES = MAX_PAYLOAD_BYTES - PIECE_PREFIX_BYTES;
const U32_MAX = 0xffffffff;
const I32_MIN = -0x80000000;
const I32_MAX = 0x7fffffff;
/**
 * 보관한 해제 알림을 다시 알리는 최대 횟수(첫 알림 제외, F-231). 재통지는 타이머 없이 handle() 호출 때만 일어나므로 횟수는
 * "그 뒤 이벤트 몇 개" 이다. 3 의 근거: 동기 콜백의 일시 실패(받는 쪽이 잠깐 바쁨·한 번 튄 예외)는 다음 한두 이벤트 안에
 * 풀리는 것이 보통이라 그 여유를 주고, 영구히 던지는 onRelease 에는 알림 하나당 추가 호출을 3 번으로 묶는다. 이벤트 하나가
 * 보관 알림을 많아야 하나 더하고 각 알림은 많아야 3 번의 handle 동안 남으므로 보관 목록 길이도 4 이하로 묶인다.
 */
export const RELEASE_RETRY_LIMIT = 3;

/**
 * 송출 중 실패한 level_arrived 가 끝나지 않았는데 다른 이벤트가 들어왔을 때 던진다(F-204).
 * 복구는 같은 이벤트를 다시 넣는 것뿐이다. pending 은 끝나지 않은 이벤트 요약이다.
 */
export class UnfinishedEventError extends Error {
  /** @param {{segmentId:number, level:number, firstPieceSeq:number, pieceCount:number}} pending */
  constructor(pending) {
    super(`송출이 끝나지 않은 이벤트(구간 ${pending.segmentId}, 수준 ${pending.level}, pieceSeq ${pending.firstPieceSeq}..`
      + `${pending.firstPieceSeq + pending.pieceCount - 1})가 있다. 같은 이벤트를 다시 넣어야 한다`);
    this.name = 'UnfinishedEventError';
    this.code = 'UNFINISHED_EVENT';
    this.pending = { ...pending };
  }
}

/**
 * 코어가 내보내는 입력 이벤트(가정, 위 머리 주석 참고).
 * @typedef {{kind:'segment_expected', segmentId:number}
 *  | {kind:'level_arrived', segmentId:number, level:number, pieces:{key:PieceKey, bytes:Uint8Array}[]}} CoreEvent
 * @typedef {import('../../../contracts/proto/index.mjs').PieceKey} PieceKey
 * @typedef {import('../../../contracts/proto/index.mjs').Message} Message
 *
 * handle 결과.
 * @typedef {Object} HandleResult
 * @property {'expect'|'first'|'replace'|'skip'} action
 * @property {number} emitted        이 이벤트로 emit 한 메시지 수
 * @property {PieceKey[]} released   교체로 내보낸 이전 수준 조각 key(replace 일 때만, 아니면 [])
 * @property {PieceKey[]} [abandoned]  실패 뒤 재시도가 skip 이 되어 놓은 부분 송출 key(그 경우에만 있음, F-223 ①).
 *   levelArrivedMaybeSent 이면 [] 이다(놓지 않는다, F-235).
 * @property {true} [levelArrivedMaybeSent]  실패 뒤 재시도가 skip 이 됐고, 실패한 시도 중 하나가 LEVEL_ARRIVED emit 을
 *   불렀을 때만 있다(F-235). 그 LEVEL_ARRIVED 가 쓰였으면 받는 쪽은 그 수준을 완료로 센다. 그 수준의 조각은 모두 이미
 *   emit 이 성공했다(PIECE 들이 LEVEL_ARRIVED 보다 먼저 나간다).
 * @property {{keys:PieceKey[], info:ReleaseInfo, error:unknown}[]} [releaseDropped]
 *   재통지 상한에 닿아 버린 해제 알림(지난 결과 이후 버린 것이 있을 때만 있음, F-231). 받는 쪽은 그 key 를 스스로 놓아야 한다.
 *   바깥(깊이 0) handle 결과에만 실린다(F-231 ⑥). 사본이다.
 */

function intIn(v, lo, hi, name) {
  if (!Number.isInteger(v)) throw new TypeError(`${name} 는 정수여야 한다: ${v}`);
  if (v < lo || v > hi) throw new RangeError(`${name} 범위 밖: ${v}`);
  return v;
}

/** firstPieceSeq 검사. 없으면 PIECE_SEQ_MIN, 정수가 아니거나 범위 밖(0 포함)이면 RangeError. */
function checkFirstSeq(v) {
  if (v === undefined) return PIECE_SEQ_MIN;
  if (!Number.isInteger(v) || v < PIECE_SEQ_MIN || v > U32_MAX) {
    throw new RangeError(`firstPieceSeq 는 ${PIECE_SEQ_MIN} 이상 u32 최대 이하 정수여야 한다: ${String(v)}`);
  }
  return v;
}

function isObject(v) {
  return v !== null && typeof v === 'object';
}

/** 조각 하나를 검사하고 기계에 넣을 사본 {key, bytes} 를 돌려준다(key 는 정해진 필드만 복사). */
function checkPiece(p, i, segmentId, level) {
  if (!isObject(p)) throw new TypeError(`pieces[${i}] 는 객체여야 한다`);
  const k = p.key;
  if (!isObject(k)) throw new TypeError(`pieces[${i}].key 는 객체여야 한다`);
  const key = {
    segmentId: intIn(k.segmentId, 0, SEGMENT_ID_LIMIT - 1, `pieces[${i}].key.segmentId`),
    level: intIn(k.level, 0, LEVEL_COUNT - 1, `pieces[${i}].key.level`),
    lod: intIn(k.lod, 0, LOD_MAX, `pieces[${i}].key.lod`),
    chunkIndex: intIn(k.chunkIndex, 0, 0xffff, `pieces[${i}].key.chunkIndex`),
    tileX: intIn(k.tileX, I32_MIN, I32_MAX, `pieces[${i}].key.tileX`),
    tileY: intIn(k.tileY, I32_MIN, I32_MAX, `pieces[${i}].key.tileY`),
  };
  if (key.segmentId !== segmentId) throw new RangeError(`pieces[${i}].key.segmentId(${key.segmentId}) 가 이벤트 구간(${segmentId})과 다르다`);
  if (key.level !== level) throw new RangeError(`pieces[${i}].key.level(${key.level}) 가 이벤트 수준(${level})과 다르다`);
  const b = p.bytes;
  if (!(b instanceof Uint8Array)) throw new TypeError(`pieces[${i}].bytes 는 Uint8Array 여야 한다`);
  if (b.length < 1 || b.length > MAX_PIECE_BYTES) throw new RangeError(`pieces[${i}].bytes 길이 범위 밖: ${b.length}`);
  return { key, bytes: b };
}

/**
 * @param {Object} [options]
 * @param {import('../../../contracts/levels/index.mjs').LevelMachine} [options.levelMachine]  기본: server/levels/state 의 새 기계
 * @param {(message: Message | Uint8Array) => void} options.emit   내보낼 메시지를 받는다(encode 가 있으면 부호화된 바이트)
 * @param {(message: Message) => Uint8Array} [options.encode]      주입 코덱. 주면 emit 에 encode(message) 를 넘긴다
 * @param {ReleaseFn | ReleaseFn[]} [options.onRelease]  교체 알림. 배열이면 순서대로 모두 부른다
 * @param {number} [options.firstPieceSeq]  첫 pieceSeq(PIECE_SEQ_MIN..u32 최대, 기본 PIECE_SEQ_MIN). 0 은 '받은 것 없음' 전용이라 RangeError
 * @param {number} [options.releaseRetryLimit]  실패한 해제 알림의 최대 재통지 횟수(0 이상 정수, 기본 RELEASE_RETRY_LIMIT)
 * @typedef {{segmentId:number, level:number, previousLevel:number, abandoned?:true}} ReleaseInfo
 *   abandoned 는 실패 뒤 재시도가 skip 이 되어 부분 송출 key 를 놓을 때만 true 로 붙는다(replace 에는 없다).
 * @typedef {(keys: PieceKey[], info: ReleaseInfo) => void} ReleaseFn
 *   같은 key 의 중복 해제를 견뎌야 한다(재통지·여러 onRelease 중 일부 실패 때 같은 key 가 다시 온다).
 */
export function createCoreAdapter(options = {}) {
  if (!isObject(options)) throw new TypeError('options 는 객체여야 한다');
  const machine = options.levelMachine === undefined ? createLevelMachine() : options.levelMachine;
  if (!isObject(machine) || typeof machine.arrive !== 'function' || typeof machine.expect !== 'function'
    || typeof machine.snapshot !== 'function') {
    throw new TypeError('levelMachine 은 arrive·expect·snapshot 을 가진 수준 기계여야 한다');
  }
  const { emit, encode, onRelease } = options;
  if (typeof emit !== 'function') throw new TypeError('emit 은 함수여야 한다');
  if (encode !== undefined && typeof encode !== 'function') throw new TypeError('encode 는 함수여야 한다');
  const releaseFns = onRelease === undefined ? [] : Array.isArray(onRelease) ? onRelease.slice() : [onRelease];
  if (!releaseFns.every((f) => typeof f === 'function')) throw new TypeError('onRelease 는 함수 또는 함수 배열이어야 한다');
  let nextSeq = checkFirstSeq(options.firstPieceSeq);
  const releaseRetryLimit = options.releaseRetryLimit === undefined ? RELEASE_RETRY_LIMIT : options.releaseRetryLimit;
  if (!Number.isInteger(releaseRetryLimit) || releaseRetryLimit < 0) {
    throw new RangeError(`releaseRetryLimit 는 0 이상 정수여야 한다: ${String(releaseRetryLimit)}`);
  }
  /**
   * 송출(③) 중 실패한 level_arrived(F-204). null 이면 없음. pieceSeq nextSeq..nextSeq+keys.length-1 은 이 key 들에 묶였다.
   * levelArrivedTried 는 실패한 시도 중 하나라도 LEVEL_ARRIVED 의 emit 을 불렀는가(F-235). 한 번 참이면 재시도가 더 일찍
   * 실패해도 참으로 남는다(앞 시도의 LEVEL_ARRIVED 가 이미 쓰였을 수 있다).
   * @type {null | {segmentId:number, level:number, keys:string[], bytes:Uint8Array[], levelArrivedTried:boolean}}
   */
  let unfinished = null;
  /** handle() 중첩 깊이(F-231 ⑥). onRelease 가 같은 어댑터의 handle() 을 부르면 1 이상이 된다. */
  let depth = 0;
  /**
   * onRelease 가 던져 끝나지 못한 해제 알림들(skip 의 abandoned·replace 모두, F-229 ②·F-231). 상태는 이미 정리됐으므로 이
   * 알림만 남는다. 다음 handle() 호출이 이벤트를 처리하기 전에 다시 알린다. 여러 onRelease 중 일부만 던졌어도 다시 알릴
   * 때는 전부 부른다(받는 쪽은 같은 key 의 두 번째 해제에 견뎌야 한다). retries 는 재통지 실패 횟수다.
   * @type {{keys:object[], info:object, retries:number}[]}
   */
  const pendingReleases = [];
  /** 재통지 상한에 닿아 버렸고 아직 결과로 알리지 못한 알림(다음에 돌려주는 결과의 releaseDropped 로 나간다). */
  let dropped = [];

  function removePending(entry) {
    const i = pendingReleases.indexOf(entry);
    if (i >= 0) pendingReleases.splice(i, 1);
  }

  function dropPending(entry, error) {
    removePending(entry);
    dropped.push({ keys: entry.keys.map((k) => ({ ...k })), info: { ...entry.info }, error });
  }

  /** 알림을 보관한 채 알리고, 끝나면 보관에서 뺀다. 던지면 보관한 채(상한 0 이면 버리고) 다시 던진다. */
  function notifyRetained(keys, info) {
    const entry = { keys, info, retries: 0 };
    pendingReleases.push(entry); // 알림이 끝나야 뺀다(F-229 ②)
    try {
      notifyRelease(keys, info);
    } catch (e) {
      if (releaseRetryLimit === 0) dropPending(entry, e);
      throw e;
    }
    removePending(entry);
  }

  /**
   * 기계가 지금 쥔 key 는 걸러낸다(F-231 ②). 보관하는 동안 공유 기계가 같은 수준·같은 key 를 확정했으면 그 조각은 지금
   * 그려지고 있을 수 있으므로 놓으라고 알리면 안 된다. key 의 수준(abandoned 는 이벤트 수준, replace 는 이전 수준)과 기계의
   * 현재 수준이 같을 때만 본다. live 판정은 skip 경로와 같이 key 문자열만 본다(F-229 ③).
   */
  function notLive(entry) {
    const snap = machine.snapshot(entry.info.segmentId);
    const live = new Set();
    for (const p of snap.pieces || []) live.add(pieceKeyString(p.key));
    return entry.keys.filter((k) => !(k.level === snap.level && live.has(pieceKeyString(k))));
  }

  /**
   * 보관한 알림을 다시 알린다. 던지지 않는다: 재통지 실패는 삼키고 횟수만 센다(F-231 ①). 재통지 실패가 예외로 handle 을
   * 끊으면 계속 던지는 onRelease 하나가 이후 이벤트를 하나도 처리하지 못하게 만든다(영구 먹통). 상한에 닿으면 버리고
   * 결과의 releaseDropped 로 알린다.
   */
  function flushPendingReleases() {
    for (const entry of pendingReleases.slice()) {
      try {
        const keys = notLive(entry);
        if (keys.length > 0) notifyRelease(keys, entry.info);
      } catch (e) {
        entry.retries++;
        if (entry.retries >= releaseRetryLimit) dropPending(entry, e);
        continue;
      }
      removePending(entry);
    }
  }

  /** 버린 알림이 있으면 결과에 releaseDropped 로 싣고 비운다(없으면 결과 모양 그대로). 바깥 handle 만 부른다(F-231 ⑥). */
  function withDropped(result) {
    if (dropped.length === 0) return result;
    const out = { ...result, releaseDropped: dropped };
    dropped = [];
    return out;
  }

  function unfinishedInfo() {
    return { segmentId: unfinished.segmentId, level: unfinished.level, firstPieceSeq: nextSeq, pieceCount: unfinished.keys.length };
  }

  /** 끝나지 않은 이벤트와 같은 이벤트인가(같은 구간·수준, 같은 순서의 같은 key·같은 bytes). */
  function sameAsUnfinished(segmentId, level, pieces) {
    const u = unfinished;
    if (u.segmentId !== segmentId || u.level !== level || u.keys.length !== pieces.length) return false;
    for (let i = 0; i < pieces.length; i++) {
      if (pieceKeyString(pieces[i].key) !== u.keys[i]) return false;
      const a = pieces[i].bytes, b = u.bytes[i];
      if (a.length !== b.length) return false;
      for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) return false;
    }
    return true;
  }

  function send(message) {
    emit(encode ? encode(message) : message);
  }

  /** onRelease 를 모두 부르고, 던진 것이 있으면 다 부른 뒤 다시 던진다. */
  function notifyRelease(keys, info) {
    const errors = [];
    for (const f of releaseFns) {
      try { f(keys.map((k) => ({ ...k })), { ...info }); } catch (e) { errors.push(e); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `onRelease ${errors.length} 개가 던졌다`);
  }

  function onExpected(ev) {
    const segmentId = intIn(ev.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId');
    if (unfinished) throw new UnfinishedEventError(unfinishedInfo());
    machine.expect(segmentId);
    if (!machine.snapshot(segmentId).missing) return { action: 'expect', emitted: 0, released: [] };
    send({ type: 'MISSING', segmentId });
    return { action: 'expect', emitted: 1, released: [] };
  }

  function onArrived(ev) {
    const segmentId = intIn(ev.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId');
    const level = intIn(ev.level, 0, LEVEL_COUNT - 1, 'level');
    if (!Array.isArray(ev.pieces)) throw new TypeError('pieces 는 배열이어야 한다');
    if (ev.pieces.length === 0) throw new RangeError('pieces 는 1 개 이상이어야 한다(빈 수준 도착은 거부, F-203)');
    const pieces = ev.pieces.map((p, i) => checkPiece(p, i, segmentId, level));
    const seen = new Set();
    for (const p of pieces) {
      const s = pieceKeyString(p.key);
      if (seen.has(s)) throw new RangeError(`같은 조각 key 가 두 번 있다: ${s}`);
      seen.add(s);
    }
    // 끝나지 않은 이벤트가 있으면 같은 이벤트의 재시도만 받는다(F-204). 순번은 그 이벤트의 key 들에 묶여 있다.
    if (unfinished && !sameAsUnfinished(segmentId, level, pieces)) throw new UnfinishedEventError(unfinishedInfo());
    // pieceSeq 는 u32 이다. 넘치면 되감지 않고 거부한다(받은 쪽 순번이 거꾸로 가지 않게).
    if (nextSeq + pieces.length - 1 > U32_MAX) throw new RangeError('pieceSeq 가 u32 범위를 넘는다');

    // ① 결정을 미리 본다. 상태는 아직 바꾸지 않는다.
    const planned = decideArrival(machine.snapshot(segmentId).level, level);
    if (planned === ACTIONS.SKIP) {
      // skip 은 기계에도 알린다(기계 이력 등). 상태는 바뀌지 않는다.
      const r = machine.arrive(segmentId, level, pieces);
      if (r.action !== ACTIONS.SKIP) throw new Error(`수준 기계 결정(${r.action})이 snapshot 으로 본 결정(skip)과 다르다`);
      if (!unfinished) return { action: 'skip', emitted: 0, released: [] };
      // 실패한 시도의 재시도가 그 사이 더 높거나 같은 수준이 도착해 skip 이 된 경우(F-223 ①). 실패한 시도가 조각 일부를
      // 이미 내보냈을 수 있다. LEVEL_ARRIVED emit 까지 가지 않았다면 그 조각들은 완료 표시가 없으므로 받는 쪽은 수준 도착으로 세지 않고 버린다
      // (도착하지 않은 것을 메우지 않는다 — 수준은 교체될 뿐이다). 어댑터는 끝나지 않은 표시를 지우고(안 지우면 이후
      // 모든 이벤트가 UNFINISHED_EVENT 로 막힌다), 그 pieceSeq 들은 이미 그 key 로 쓰였을 수 있으므로 태워서 다른 key 에
      // 다시 쓰지 않으며, onRelease 로 그 key 들을 놓는다(info.abandoned = true).
      // 같은 수준(L == M)이면 공유 기계가 같은 key 의 조각을 이미 확정해 지금 그려지고 있을 수 있다(F-227). 기계의 현재 수준이
      // 쥔 key 는 놓지 않는다. L < M 이면 그 수준의 조각이 아니므로 그대로 모두 놓는다.
      if (unfinished.levelArrivedTried) {
        // 실패한 시도가 LEVEL_ARRIVED emit 을 불렀다(F-235). 그 앞의 PIECE 들은 모두 emit 이 성공했고, LEVEL_ARRIVED 가
        // 쓰였으면 받는 쪽은 이 수준을 완료로 세어 그 key 를 그린다. 그리는 key 를 놓으라고 알리지 않는다. 쓰이지 않았으면
        // 받는 쪽이 완료 표시 없는 조각을 스스로 버린다. 어느 쪽인지 어댑터는 모르므로 표시만 붙인다.
        nextSeq += unfinished.keys.length;
        unfinished = null;
        return { action: 'skip', emitted: 0, released: [], abandoned: [], levelArrivedMaybeSent: true };
      }
      const snap = machine.snapshot(segmentId);
      // live 판정은 key 문자열만 본다(F-229 ③). 같은 key 인데 실패한 시도가 다른 bytes·pieceSeq 로 이미 내보냈다면 받는
      // 쪽이 쥔 조각과 기계가 쥔 조각이 다를 수 있다. 규칙: 같은 key 는 같은 bytes 라는 것이 계약이고(조각 key 가 내용을
      // 식별한다), 어댑터는 bytes 를 비교하지 않는다. 같은 key 에 다른 bytes 를 보내는 호출자는 계약 위반이다.
      const live = new Set();
      if (snap.level === level) for (const p of snap.pieces) live.add(pieceKeyString(p.key));
      const abandonedInfo = { segmentId, level, previousLevel: snap.level, abandoned: true };
      const abandoned = pieces.filter((p) => !live.has(pieceKeyString(p.key))).map((p) => ({ ...p.key }));
      nextSeq += unfinished.keys.length;
      unfinished = null;
      if (abandoned.length > 0) notifyRetained(abandoned, abandonedInfo);
      return { action: 'skip', emitted: 0, released: [], abandoned };
    }
    // ② 메시지를 모두 만들고 부호화까지 마친다. 여기서 던지면 아무것도 나가지 않는다.
    const messages = pieces.map((p, i) => ({ type: 'PIECE', pieceSeq: nextSeq + i, key: { ...p.key }, chunk: p.bytes }));
    messages.push({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount: pieces.length });
    const outgoing = encode ? messages.map((m) => encode(m)) : messages;
    // ③ 전부 송출한다. 던지면 상태·nextSeq 를 확정하지 않고, 이 이벤트를 끝나지 않은 이벤트로 남긴 채 다시 던진다.
    if (!unfinished) {
      unfinished = {
        segmentId, level, keys: pieces.map((p) => pieceKeyString(p.key)), bytes: pieces.map((p) => new Uint8Array(p.bytes)), // 실제 사본(Buffer.slice 는 뷰, F-219 ①)
        levelArrivedTried: false,
      };
    }
    for (let i = 0; i < outgoing.length; i++) {
      // 마지막은 LEVEL_ARRIVED 다. emit 을 부르기 전에 표시한다 — 던졌어도 선에 쓰였을 수 있다(F-235).
      if (i === outgoing.length - 1) unfinished.levelArrivedTried = true;
      emit(outgoing[i]);
    }
    // ④ 송출이 끝났다. 순번을 확정하고(이 pieceSeq 들은 이제 쓰였다) 끝나지 않은 표시를 지운 뒤 상태를 확정한다.
    unfinished = null;
    nextSeq += pieces.length;
    const r = machine.arrive(segmentId, level, pieces);
    if (r.action !== planned) throw new Error(`수준 기계 결정(${r.action})이 snapshot 으로 본 결정(${planned})과 다르다`);
    let released = [];
    if (r.action === ACTIONS.REPLACE) {
      released = r.released.map((p) => ({ ...p.key }));
      // ⑤ 상태 확정 뒤 알림. 하나가 던져도 전부 부르고 다시 던진다. 던지면 skip 의 abandoned 와 같은 규칙으로 보관했다가
      // 다음 handle 에서 다시 알린다(F-231 ③). 이전 수준 조각을 놓으라는 알림이 사라지면 받는 쪽이 그 조각을 영영 쥐게 된다.
      notifyRetained(released, { segmentId, level, previousLevel: r.previousLevel });
    }
    return { action: r.action, emitted: pieces.length + 1, released };
  }

  return {
    /** @param {CoreEvent} event @returns {HandleResult} */
    handle(event) {
      if (!isObject(event)) throw new TypeError('event 는 객체여야 한다');
      // 재진입한 handle(onRelease 안에서 부른 것)은 재통지하지 않고 releaseDropped 도 싣지 않는다(F-231 ⑥). 바깥 handle 이
      // 알리는 중인 항목을 안쪽이 다시 알리면 끝없이 중첩되고, 안쪽 결과에 실린 releaseDropped 는 바깥 호출자에게 가지 않는다.
      const outer = depth === 0;
      depth++;
      try {
        if (outer) flushPendingReleases(); // 던지지 않는다(F-231 ①)
        let result;
        if (event.kind === 'segment_expected') result = onExpected(event);
        else if (event.kind === 'level_arrived') result = onArrived(event);
        else throw new RangeError(`모르는 이벤트 kind: ${String(event.kind)}`);
        return outer ? withDropped(result) : result;
      } finally {
        depth--;
      }
    },
    /** 다음에 쓸 pieceSeq. */
    nextPieceSeq() {
      return nextSeq;
    },
    /** 송출 중 실패해 끝나지 않은 이벤트 요약(F-204). 없으면 null. 있으면 같은 이벤트의 재시도만 받는다. */
    unfinishedEvent() {
      return unfinished ? unfinishedInfo() : null;
    },
    /** 보관 중인 해제 알림 사본(F-231). 각 항목 {keys, info, retries}. */
    pendingReleases() {
      return pendingReleases.map((e) => ({ keys: e.keys.map((k) => ({ ...k })), info: { ...e.info }, retries: e.retries }));
    },
  };
}
