// 도착 기준 노출(T13.3). 도착한 구간(level >= 0)만 보이고, 도착 전 구간은 점 0 으로 숨긴다. 메우거나 보간하지 않는다.
// 입력 검증은 client/levels/missing 의 describeSegments 를 그대로 쓴다(level·missing 어긋남은 TypeError).
import { describeSegments } from '../../levels/missing/index.mjs';

/**
 * @param {import('../../../contracts/levels/index.mjs').SegmentState[]} states
 * @returns {{visible:number[], hidden:number[], renderPointCount:number}}
 */
export function computeReveal(states) {
  const described = describeSegments(states);
  const seen = new Set();
  const visible = [];
  const hidden = [];
  let renderPointCount = 0;
  for (const d of described) {
    if (seen.has(d.segmentId)) throw new TypeError(`구간 번호가 중복된다: ${d.segmentId}`);
    seen.add(d.segmentId);
    if (d.missing) {
      hidden.push(d.segmentId);
    } else {
      visible.push(d.segmentId);
      renderPointCount += d.renderPointCount;
    }
  }
  if (!Number.isSafeInteger(renderPointCount)) throw new RangeError('renderPointCount 가 안전 정수를 넘는다');
  return { visible, hidden, renderPointCount };
}
