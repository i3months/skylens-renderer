import { PointsError } from '../../../contracts/points/index.mjs';
import { LEVEL_STEPS, SEGMENT_ID_LIMIT } from '../../../contracts/asset/index.mjs';

// 이름 규칙: seg<구간>_step<5자리>.ply (구간은 앞자리 0 없는 10진수)
const NAME_RE = /^seg(0|[1-9][0-9]*)_step([0-9]{5})\.ply$/;

/** 구간 PLY 파일 이름 묶음 식별.
 * 이름 규칙 밖 항목(.DS_Store 등)은 실패시키지 않고 결과 배열의 `rejected`(이름 목록)로 따로 돌려준다.
 * 빠진 수준·구간은 채우지 않는다. 같은 (구간, 수준) 중복은 모호하므로 PointsError('name').
 * @param {string[]} fileNames
 * @returns {{segmentId: number, level: 0|1|2|3, fileName: string}[] & {rejected: string[]}} */
export function identifySegments(fileNames) {
  if (!Array.isArray(fileNames)) throw new PointsError('name', 'file name list expected');
  const seen = new Set();
  const out = [];
  const rejected = [];
  for (const fileName of fileNames) {
    const m = typeof fileName === 'string' ? NAME_RE.exec(fileName) : null;
    const level = m ? LEVEL_STEPS.indexOf(Number(m[2])) : -1;
    const segmentId = m ? Number(m[1]) : -1;
    // 규칙 밖(형식·미지의 수준·범위 초과)은 거부 목록으로 보낸다
    if (!m || level < 0 || !Number.isSafeInteger(segmentId) || segmentId >= SEGMENT_ID_LIMIT) {
      rejected.push(String(fileName));
      continue;
    }
    const key = segmentId * 4 + level;
    if (seen.has(key)) throw new PointsError('name', `duplicate segment/level: ${fileName}`);
    seen.add(key);
    out.push({ segmentId, level, fileName });
  }
  out.sort((a, b) => a.segmentId - b.segmentId || a.level - b.level);
  // 기존 배열 반환 형태 유지: 열거 불가 속성으로 추가만 한다
  Object.defineProperty(out, 'rejected', { value: rejected, enumerable: false });
  return out;
}
