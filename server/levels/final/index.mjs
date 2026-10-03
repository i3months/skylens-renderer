// 마지막 수준 완료 표시(T10.6)
import { FINAL_LEVEL } from '../../../contracts/levels/index.mjs';

/**
 * 구간이 마지막 수준(FINAL_LEVEL)에 도달했는지 확인한다.
 * @param {LevelMachine} machine - 수준 기계
 * @param {number} segmentId - 구간 번호
 * @returns {boolean} 구간이 마지막 수준이면 true, 아니면 false
 */
export function isSegmentFinal(machine, segmentId) {
  const state = machine.snapshot(segmentId);
  return state.final;
}

/**
 * 주어진 모든 구간이 마지막 수준에 도달했는지 확인한다.
 * @param {LevelMachine} machine - 수준 기계
 * @param {number[]} segmentIds - 확인할 구간 번호 목록
 * @returns {boolean} 빈 목록이면 false, 모든 구간이 마지막 수준이면 true, 그 외는 false
 */
export function allFinal(machine, segmentIds) {
  if (segmentIds.length === 0) return false;
  for (const id of segmentIds) {
    if (!isSegmentFinal(machine, id)) return false;
  }
  return true;
}
