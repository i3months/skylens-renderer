import { PointsError } from '../../../contracts/points/index.mjs';
import { LEVEL_STEPS, SEGMENT_ID_LIMIT } from '../../../contracts/asset/index.mjs';

// 이름 규칙: seg<구간>_step<5자리>.ply (구간은 앞자리 0 없는 10진수)
const NAME_RE = /^seg(0|[1-9][0-9]*)_step([0-9]{5})\.ply$/;

/** 구간 PLY 파일 이름 묶음 식별. 규칙 밖·중복은 PointsError('name').
 * @param {string[]} fileNames @returns {{segmentId: number, level: 0|1|2|3, fileName: string}[]} */
export function identifySegments(fileNames) {
  if (!Array.isArray(fileNames)) throw new PointsError('name', 'file name list expected');
  const seen = new Set();
  const out = [];
  for (const fileName of fileNames) {
    const m = typeof fileName === 'string' ? NAME_RE.exec(fileName) : null;
    if (!m) throw new PointsError('name', `bad segment file name: ${String(fileName)}`);
    const segmentId = Number(m[1]);
    const level = LEVEL_STEPS.indexOf(Number(m[2]));
    if (level < 0) throw new PointsError('name', `unknown step: ${fileName}`);
    if (!Number.isSafeInteger(segmentId) || segmentId >= SEGMENT_ID_LIMIT) {
      throw new PointsError('name', `segment id out of range: ${fileName}`);
    }
    const key = segmentId * 4 + level;
    if (seen.has(key)) throw new PointsError('name', `duplicate segment/level: ${fileName}`);
    seen.add(key);
    out.push({ segmentId, level, fileName });
  }
  return out.sort((a, b) => a.segmentId - b.segmentId || a.level - b.level);
}
