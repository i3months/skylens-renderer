// 서버 수준 상태 기계(T10.1). 계약: contracts/levels/index.mjs
// 구간마다 현재 수준과 그 수준의 조각만 보관한다. 타이머·시계를 쓰지 않는다.
import { NONE, FINAL_LEVEL, ACTIONS, decideArrival, assertSegmentId, assertLevel } from '../../../contracts/levels/index.mjs';

export function createLevelMachine(options = {}) {
  const recordHistory = options.recordHistory === true;
  /** @type {Map<number,{level:number,pieces:any[]}>} */
  const segs = new Map();
  const log = [];
  let seq = 0;

  function entry(id) {
    let e = segs.get(id);
    if (!e) { e = { level: NONE, pieces: [] }; segs.set(id, e); }
    return e;
  }

  function checkPieces(pieces) {
    if (pieces === undefined) return [];
    if (!Array.isArray(pieces)) throw new TypeError('pieces 는 배열이어야 한다');
    return pieces;
  }

  return {
    arrive(segmentId, level, pieces) {
      assertSegmentId(segmentId);
      assertLevel(level);
      const given = checkPieces(pieces);
      const e = segs.get(segmentId);
      const previousLevel = e ? e.level : NONE;
      const action = decideArrival(previousLevel, level);
      let released = [];
      if (action !== ACTIONS.SKIP) {
        const cur = e || entry(segmentId);
        released = cur.pieces;
        cur.level = level;
        cur.pieces = given.slice();
      }
      if (recordHistory) log.push({ seq: seq, segmentId, level, action });
      seq++;
      return { segmentId, level, action, previousLevel, accepted: action !== ACTIONS.SKIP, released };
    },
    expect(segmentId) {
      assertSegmentId(segmentId);
      entry(segmentId);
    },
    snapshot(segmentId) {
      assertSegmentId(segmentId);
      const e = segs.get(segmentId);
      const level = e ? e.level : NONE;
      return { segmentId, level, missing: level === NONE, final: level === FINAL_LEVEL, pieces: e ? e.pieces.slice() : [] };
    },
    segments() {
      return [...segs.keys()].sort((a, b) => a - b);
    },
    pointCount(segmentId) {
      assertSegmentId(segmentId);
      const e = segs.get(segmentId);
      if (!e) return 0;
      let n = 0;
      for (const p of e.pieces) n += p && Number.isFinite(p.count) ? p.count : 0;
      return n;
    },
    history() {
      return log.map((h) => ({ ...h }));
    },
  };
}
