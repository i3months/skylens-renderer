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
//     replace              : 기계가 released 로 내보낸 이전 수준 조각의 key 목록을 onRelease(keys, info) 로 알린다.
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
//     recordSent 를 불러도 재시도가 막히지 않는다.
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
 * @typedef {(keys: PieceKey[], info: {segmentId:number, level:number, previousLevel:number}) => void} ReleaseFn
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
  /**
   * 송출(③) 중 실패한 level_arrived(F-204). null 이면 없음. pieceSeq nextSeq..nextSeq+keys.length-1 은 이 key 들에 묶였다.
   * @type {null | {segmentId:number, level:number, keys:string[], bytes:Uint8Array[]}}
   */
  let unfinished = null;

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
      return { action: 'skip', emitted: 0, released: [] };
    }
    // ② 메시지를 모두 만들고 부호화까지 마친다. 여기서 던지면 아무것도 나가지 않는다.
    const messages = pieces.map((p, i) => ({ type: 'PIECE', pieceSeq: nextSeq + i, key: { ...p.key }, chunk: p.bytes }));
    messages.push({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount: pieces.length });
    const outgoing = encode ? messages.map((m) => encode(m)) : messages;
    // ③ 전부 송출한다. 던지면 상태·nextSeq 를 확정하지 않고, 이 이벤트를 끝나지 않은 이벤트로 남긴 채 다시 던진다.
    if (!unfinished) {
      unfinished = {
        segmentId, level, keys: pieces.map((p) => pieceKeyString(p.key)), bytes: pieces.map((p) => p.bytes.slice()),
      };
    }
    for (const m of outgoing) emit(m);
    // ④ 송출이 끝났다. 순번을 확정하고(이 pieceSeq 들은 이제 쓰였다) 끝나지 않은 표시를 지운 뒤 상태를 확정한다.
    unfinished = null;
    nextSeq += pieces.length;
    const r = machine.arrive(segmentId, level, pieces);
    if (r.action !== planned) throw new Error(`수준 기계 결정(${r.action})이 snapshot 으로 본 결정(${planned})과 다르다`);
    let released = [];
    if (r.action === ACTIONS.REPLACE) {
      released = r.released.map((p) => ({ ...p.key }));
      // ⑤ 상태 확정 뒤 알림. 하나가 던져도 전부 부르고 다시 던진다.
      notifyRelease(released, { segmentId, level, previousLevel: r.previousLevel });
    }
    return { action: r.action, emitted: pieces.length + 1, released };
  }

  return {
    /** @param {CoreEvent} event @returns {HandleResult} */
    handle(event) {
      if (!isObject(event)) throw new TypeError('event 는 객체여야 한다');
      if (event.kind === 'segment_expected') return onExpected(event);
      if (event.kind === 'level_arrived') return onArrived(event);
      throw new RangeError(`모르는 이벤트 kind: ${String(event.kind)}`);
    },
    /** 다음에 쓸 pieceSeq. */
    nextPieceSeq() {
      return nextSeq;
    },
    /** 송출 중 실패해 끝나지 않은 이벤트 요약(F-204). 없으면 null. 있으면 같은 이벤트의 재시도만 받는다. */
    unfinishedEvent() {
      return unfinished ? unfinishedInfo() : null;
    },
  };
}
