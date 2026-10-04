// 교체 시 낮은 수준 조각 해제 장부(T10.3). 계약: contracts/levels/index.mjs
// 기계의 arrive 를 감싸, 교체로 내보낸 조각마다 해제 콜백을 부르고 보관 조각 수를 센다.
import { assertSegmentId } from '../../../contracts/levels/index.mjs';

export function createPieceLedger(machine, options = {}) {
  const onRelease = typeof options.onRelease === 'function' ? options.onRelease : null;

  return {
    arrive(segmentId, level, pieces) {
      const result = machine.arrive(segmentId, level, pieces);
      if (onRelease) {
        // 콜백이 던져도 나머지 조각의 해제를 모두 부른 뒤 첫 오류를 던진다.
        let failed = false;
        let first;
        for (const piece of result.released) {
          try { onRelease(piece); } catch (err) { if (!failed) { failed = true; first = err; } }
        }
        if (failed) throw first;
      }
      return result;
    },
    /** 구간을 주면 그 구간, 생략하면 전체 구간의 보관 조각 수. */
    heldPieceCount(segmentId) {
      if (segmentId !== undefined) {
        assertSegmentId(segmentId);
        return machine.snapshot(segmentId).pieces.length;
      }
      let n = 0;
      for (const id of machine.segments()) n += machine.snapshot(id).pieces.length;
      return n;
    },
    machine,
  };
}
