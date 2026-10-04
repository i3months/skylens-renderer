import { LEVEL_STEPS, LEVEL_COUNT, SEGMENT_ID_LIMIT } from '../asset/index.mjs';

// 수준(level) 계약(T10). skylens 딜레이 패턴 원칙을 그대로 옮긴다.
//   수준은 4개(스텝 250·1,000·3,500·7,000). 새 수준은 같은 구간의 낮은 수준을 "교체" 한다(누적 아님).
//   이미 더 높은 수준이 도착한 구간에 늦게 온 낮은(또는 같은) 수준은 추월당한 것이므로 건너뛴다(저장·표시하지 않는다).
//   도착하지 않은 구간은 "없음" 이다. 렌더 점 0, 표시 상태 참. 그 자리를 메우거나 꾸미지 않는다.
//   시간은 상태를 바꾸지 않는다: 이 모듈에는 타이머·시계가 없고, 상태는 도착 이벤트로만 바뀐다.
// 수준 번호: 0..3 (LEVEL_STEPS 의 인덱스). 구간(segment) 번호: 0 이상 SEGMENT_ID_LIMIT(2^30, contracts/asset) 미만 정수.
//
// 기계 인터페이스(서버 server/levels/state 와 클라이언트 client/levels 가 같은 서명을 내보낸다):
//   createLevelMachine(options?) -> LevelMachine
//   LevelMachine.arrive(segmentId, level, pieces?) -> ArriveResult
//     pieces 는 그 수준의 조각 목록(불투명 값. 서버는 조각 참조, 클라이언트는 그릴 조각). 생략하면 [].
//     결정은 decideArrival(현재 수준, 도착 수준) 과 같다.
//       first    : 현재 NONE(-1) → 도착 수준을 저장. released = [].
//       replace  : 도착 수준 > 현재 수준 → 낮은 수준 조각 전부 released 로 내보내고 새 조각만 보관(누적 0).
//       skip     : 도착 수준 ≤ 현재 수준 → 아무것도 바꾸지 않는다. released = [], accepted = false.
//   LevelMachine.expect(segmentId) -> void   도착 전 구간을 "없음" 으로 등록(이미 도착한 구간은 건드리지 않는다).
//   LevelMachine.snapshot(segmentId) -> SegmentState   모르는 구간도 "없음" 상태를 돌려준다(등록하지 않는다).
//   LevelMachine.segments() -> number[]   arrive·expect 로 알려진 구간 번호, 오름차순.
//   LevelMachine.pointCount(segmentId) -> number   보관 중 조각의 count 합. 없음이면 0.
//   LevelMachine.history() -> HistoryEntry[]   options.recordHistory === true 일 때만 기록(서버 디버그). 아니면 [].
// 조각 count 정의역: 조각이 count 를 가지면(undefined 면 0 으로 센다) 0 이상 안전 정수여야 한다.
//   숫자가 아니거나 정수가 아니면(NaN·Infinity·소수 포함) TypeError, 음수·안전 정수 초과면 RangeError. -0 은 0 으로 정규화한다.
//   arrive 는 상태를 바꾸기 전에 검사하고, 구간 count 합도 안전 정수 이내여야 한다(pointCount 와 renderPointCount 는 같은 함수 pieceCount·sumPieceCounts 를 쓴다).
// 입력 검사: segmentId 는 0 이상 SEGMENT_ID_LIMIT 미만 정수, level 은 0..3 정수, pieces 는 배열(또는 undefined). 어긋나면 RangeError/TypeError.

/** 수준별 딜레이 패턴 스텝·수준 수·구간 번호 한도는 contracts/asset 의 같은 객체를 다시 내보낸다. */
export { LEVEL_STEPS, LEVEL_COUNT, SEGMENT_ID_LIMIT };
export const FINAL_LEVEL = 3;
/** 아직 아무 수준도 도착하지 않음. */
export const NONE = -1;
export const ACTIONS = Object.freeze({ FIRST: 'first', REPLACE: 'replace', SKIP: 'skip' });
export const MAX_SEGMENT_ID = SEGMENT_ID_LIMIT - 1;

/**
 * @typedef {Object} SegmentState
 * @property {number} segmentId
 * @property {number} level       현재 수준 0..3, 도착 전이면 NONE(-1)
 * @property {boolean} missing    level === NONE
 * @property {boolean} final      level === FINAL_LEVEL
 * @property {any[]} pieces       현재 수준의 조각만(사본). 없음이면 []
 *
 * @typedef {Object} ArriveResult
 * @property {number} segmentId
 * @property {number} level           도착한 수준
 * @property {'first'|'replace'|'skip'} action
 * @property {number} previousLevel   도착 직전 수준(NONE 가능)
 * @property {boolean} accepted       action !== 'skip'
 * @property {any[]} released         교체로 내보낸 이전 수준 조각(replace 일 때만, 아니면 [])
 *
 * @typedef {Object} HistoryEntry
 * @property {number} seq        0부터 도착 순번(skip 포함)
 * @property {number} segmentId
 * @property {number} level
 * @property {'first'|'replace'|'skip'} action
 *
 * @typedef {Object} LevelMachine
 * @property {(segmentId:number, level:number, pieces?:any[]) => ArriveResult} arrive
 * @property {(segmentId:number) => void} expect
 * @property {(segmentId:number) => SegmentState} snapshot
 * @property {() => number[]} segments
 * @property {(segmentId:number) => number} pointCount
 * @property {() => HistoryEntry[]} history
 */

export function assertSegmentId(segmentId) {
  if (!Number.isInteger(segmentId)) throw new TypeError(`segmentId 는 정수여야 한다: ${segmentId}`);
  if (Object.is(segmentId, -0)) throw new RangeError('segmentId 는 -0 일 수 없다(0 을 쓴다)');
  if (segmentId < 0 || segmentId > MAX_SEGMENT_ID) throw new RangeError(`segmentId 범위 밖: ${segmentId}`);
}

export function assertLevel(level) {
  if (!Number.isInteger(level)) throw new TypeError(`level 은 정수여야 한다: ${level}`);
  if (level < 0 || level >= LEVEL_COUNT) throw new RangeError(`level 범위 밖: ${level}`);
}

/** 조각 하나의 count(없으면 0). 정의역 밖이면 TypeError/RangeError. -0 은 0. */
export function pieceCount(piece) {
  const count = piece === null || typeof piece !== 'object' ? undefined : piece.count;
  if (count === undefined) return 0;
  if (typeof count !== 'number') throw new TypeError(`조각 count 는 숫자여야 한다: ${String(count)}`);
  if (!Number.isInteger(count)) throw new TypeError(`조각 count 는 정수여야 한다: ${count}`);
  if (count < 0 || count > Number.MAX_SAFE_INTEGER) throw new RangeError(`조각 count 범위 밖: ${count}`);
  return count === 0 ? 0 : count;
}

/** 조각 목록 count 합. 각 count 와 합이 안전 정수 이내여야 한다. */
export function sumPieceCounts(pieces) {
  let total = 0;
  for (const piece of pieces) {
    total += pieceCount(piece);
    if (total > Number.MAX_SAFE_INTEGER) throw new RangeError(`조각 count 합이 안전 정수를 넘는다: ${total}`);
  }
  return total;
}

/** 도착 결정. current 는 NONE 또는 0..3, arriving 은 0..3. */
export function decideArrival(current, arriving) {
  assertLevel(arriving);
  if (current !== NONE) assertLevel(current);
  if (current === NONE) return ACTIONS.FIRST;
  return arriving > current ? ACTIONS.REPLACE : ACTIONS.SKIP;
}
