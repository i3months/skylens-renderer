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
//     first / replace      : 조각마다 PIECE 한 건(pieceSeq 는 어댑터가 0부터 1씩 올리는 u32), 그다음 LEVEL_ARRIVED 한 건.
//                            순서는 PIECE 들이 먼저이고 LEVEL_ARRIVED 가 마지막이다. 받는 쪽은 LEVEL_ARRIVED 를 "그 수준의
//                            조각 pieceCount 개가 모두 왔다" 는 완료 표시로 쓰고, 그때 자기 수준 기계에 arrive 한다.
//     replace              : 기계가 released 로 내보낸 이전 수준 조각의 key 목록을 onRelease(keys, info) 로 알린다.
//   도착하지 않은 것을 만들거나 메우지 않는다. 시간·타이머를 쓰지 않는다. 상태는 handle 호출로만 바뀐다.
// 입력 검사: 이벤트 전체를 기계에 넘기기 전에 검사한다(검사 실패 시 상태·순번은 그대로).
//   모양이 틀리면 TypeError, 값이 범위 밖이면 RangeError.
import { createLevelMachine } from '../../levels/state/index.mjs';
import { LEVEL_COUNT, ACTIONS } from '../../../contracts/levels/index.mjs';
import { SEGMENT_ID_LIMIT, LOD_MAX } from '../../../contracts/asset/index.mjs';
import { MAX_PAYLOAD_BYTES, PIECE_KEY_BYTES, pieceKeyString } from '../../../contracts/proto/index.mjs';

/** PIECE 본문에서 조각 바이트 앞에 오는 부분(pieceSeq u32 + PieceKey). */
const PIECE_PREFIX_BYTES = 4 + PIECE_KEY_BYTES;
/** 조각 하나의 최대 바이트(프레임 본문 상한에서 PIECE 앞부분을 뺀 값). */
export const MAX_PIECE_BYTES = MAX_PAYLOAD_BYTES - PIECE_PREFIX_BYTES;
const U32_MAX = 0xffffffff;
const I32_MIN = -0x80000000;
const I32_MAX = 0x7fffffff;

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
 * @param {(keys: PieceKey[], info: {segmentId:number, level:number, previousLevel:number}) => void} [options.onRelease]
 * @param {number} [options.firstPieceSeq]  첫 pieceSeq(u32, 기본 0)
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
  if (onRelease !== undefined && typeof onRelease !== 'function') throw new TypeError('onRelease 는 함수여야 한다');
  let nextSeq = options.firstPieceSeq === undefined ? 0 : intIn(options.firstPieceSeq, 0, U32_MAX, 'firstPieceSeq');

  function send(message) {
    emit(encode ? encode(message) : message);
  }

  function onExpected(ev) {
    const segmentId = intIn(ev.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId');
    machine.expect(segmentId);
    if (!machine.snapshot(segmentId).missing) return { action: 'expect', emitted: 0, released: [] };
    send({ type: 'MISSING', segmentId });
    return { action: 'expect', emitted: 1, released: [] };
  }

  function onArrived(ev) {
    const segmentId = intIn(ev.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId');
    const level = intIn(ev.level, 0, LEVEL_COUNT - 1, 'level');
    if (!Array.isArray(ev.pieces)) throw new TypeError('pieces 는 배열이어야 한다');
    const pieces = ev.pieces.map((p, i) => checkPiece(p, i, segmentId, level));
    const seen = new Set();
    for (const p of pieces) {
      const s = pieceKeyString(p.key);
      if (seen.has(s)) throw new RangeError(`같은 조각 key 가 두 번 있다: ${s}`);
      seen.add(s);
    }
    // pieceSeq 는 u32 이다. 넘치면 되감지 않고 거부한다(받은 쪽 순번이 거꾸로 가지 않게).
    if (pieces.length > 0 && nextSeq + pieces.length - 1 > U32_MAX) throw new RangeError('pieceSeq 가 u32 범위를 넘는다');

    const r = machine.arrive(segmentId, level, pieces);
    if (r.action === ACTIONS.SKIP) return { action: 'skip', emitted: 0, released: [] };
    for (const p of pieces) {
      send({ type: 'PIECE', pieceSeq: nextSeq, key: { ...p.key }, chunk: p.bytes });
      nextSeq++;
    }
    send({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount: pieces.length });
    let released = [];
    if (r.action === ACTIONS.REPLACE) {
      released = r.released.map((p) => ({ ...p.key }));
      if (onRelease) onRelease(released.map((k) => ({ ...k })), { segmentId, level, previousLevel: r.previousLevel });
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
  };
}
