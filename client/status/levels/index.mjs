// 현황판 수준 교체 화면(T13.2). 계약: contracts/statusview/index.mjs createStatusLevels
// 수준 판정은 client/levels createLevelMachine 에 맡기고, 여기서는 그려야 할 조각 key 와 해제할 key 만 정리한다.
// 시계·타이머 없음. 도착한 것만 그린다(도착 전 구간은 점 0, drawKeys 에 없음).
import { createLevelMachine } from '../../levels/index.mjs';

export function createStatusLevels() {
  const machine = createLevelMachine();
  let releasedKeys = [];

  function checkPieces(pieces) {
    if (!Array.isArray(pieces)) throw new TypeError('pieces 는 배열이어야 한다');
    for (const p of pieces) {
      if (p === null || typeof p !== 'object' || typeof p.key !== 'string') throw new TypeError('조각은 {key: 문자열, count} 여야 한다');
    }
  }

  function arrive(segmentId, level, pieces) {
    checkPieces(pieces);
    const result = machine.arrive(segmentId, level, pieces); // 검사 위반은 상태를 바꾸기 전에 던진다
    if (result.accepted) {
      for (const p of result.released) releasedKeys.push(p.key);
    }
    return result;
  }

  function expect(segmentId) {
    machine.expect(segmentId);
  }

  function snapshots() {
    return machine.segments().map((id) => machine.snapshot(id));
  }

  function drawKeys() {
    const keys = [];
    for (const s of snapshots()) for (const p of s.pieces) keys.push(p.key);
    return keys;
  }

  function renderPointCount() {
    let total = 0;
    for (const id of machine.segments()) total += machine.pointCount(id);
    return total;
  }

  function released() {
    const out = releasedKeys;
    releasedKeys = [];
    return out;
  }

  return { arrive, expect, snapshots, drawKeys, renderPointCount, released };
}
