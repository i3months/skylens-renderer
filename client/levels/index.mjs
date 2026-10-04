// 클라이언트 수준 상태 기계(T10.4). 계약: contracts/levels/index.mjs
// 서버 기계와 같은 서명·같은 결과를 내되 server/ 를 import 하지 않고 계약만 쓴다.
// 구간마다 현재 수준과 그 수준의 조각만 보관한다. 타이머·시계를 쓰지 않는다.
import { NONE, FINAL_LEVEL, ACTIONS, decideArrival, assertSegmentId, assertLevel, sumPieceCounts } from '../../contracts/levels/index.mjs';

export function createLevelMachine(options = {}) {
  const recordHistory = options.recordHistory === true;
  // 구간 번호 -> { level, pieces }
  const table = new Map();
  const trail = [];
  let arrivals = 0;

  function ensure(id) {
    let rec = table.get(id);
    if (rec === undefined) {
      rec = { level: NONE, pieces: [] };
      table.set(id, rec);
    }
    return rec;
  }

  function normalizePieces(pieces) {
    if (pieces === undefined) return [];
    if (!Array.isArray(pieces)) throw new TypeError('pieces 는 배열이어야 한다');
    return pieces;
  }

  function arrive(segmentId, level, pieces) {
    assertSegmentId(segmentId);
    assertLevel(level);
    const incoming = normalizePieces(pieces);
    sumPieceCounts(incoming); // 상태를 바꾸기 전에 count 정의역 검사
    const existing = table.get(segmentId);
    const previousLevel = existing === undefined ? NONE : existing.level;
    const action = decideArrival(previousLevel, level);
    let released = [];
    if (action !== ACTIONS.SKIP) {
      const rec = existing === undefined ? ensure(segmentId) : existing;
      released = rec.pieces;
      rec.level = level;
      rec.pieces = incoming.slice();
    }
    if (recordHistory) trail.push({ seq: arrivals, segmentId, level, action });
    arrivals += 1;
    return { segmentId, level, action, previousLevel, accepted: action !== ACTIONS.SKIP, released };
  }

  function expect(segmentId) {
    assertSegmentId(segmentId);
    ensure(segmentId);
  }

  function snapshot(segmentId) {
    assertSegmentId(segmentId);
    const rec = table.get(segmentId);
    const level = rec === undefined ? NONE : rec.level;
    return {
      segmentId,
      level,
      missing: level === NONE,
      final: level === FINAL_LEVEL,
      pieces: rec === undefined ? [] : rec.pieces.slice(),
    };
  }

  function segments() {
    return Array.from(table.keys()).sort((a, b) => a - b);
  }

  function pointCount(segmentId) {
    assertSegmentId(segmentId);
    const rec = table.get(segmentId);
    if (rec === undefined) return 0;
    return sumPieceCounts(rec.pieces);
  }

  function history() {
    return trail.map((h) => ({ ...h }));
  }

  return { arrive, expect, snapshot, segments, pointCount, history };
}
