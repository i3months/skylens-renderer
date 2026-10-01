// 자산 바이트 기준선 (T01.3): 구간(segment) × 수준(level) 별 점 파일 크기를 집계한다.
//
// 점 형식(27 바이트, little-endian): x y z f32×3 (12) + nx ny nz f32×3 (12) + r g b u8×3 (3).
// 자산 디렉터리 규약(가정):
//   assetsRoot 기본값은 `<skylensDir>/assets`, 파일명은 `seg<구간>_L<수준>.bin`
//   (구간은 10진 정수, 수준은 학습 스텝 250/1000/3500/7000). 구간마다 4수준이 모두 있어야 한다.
// 파일 내용은 읽지 않고 크기(stat)만 쓴다.
import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';

export const POINT_BYTES = 27;
export const LEVELS = [250, 1000, 3500, 7000];
const NAME_RE = /^seg(\d+)_L(\d+)\.bin$/;

/**
 * 점 파일 크기를 검사한다. 점 수 = (크기 − 헤더) / 27 이 정수여야 하고,
 * 크기 − 27×점수 가 헤더 크기 이하여야 한다. 위반하면 errors 에 사유가 담긴다.
 * @returns {{ok:boolean, points:number, remainder:number, errors:string[]}}
 */
export function checkPointFile(size, headerSize = 0) {
  const errors = [];
  if (!Number.isInteger(size) || size < 0) errors.push('파일 크기가 올바르지 않다');
  if (!Number.isInteger(headerSize) || headerSize < 0) errors.push('헤더 크기가 올바르지 않다');
  if (errors.length) return { ok: false, points: 0, remainder: 0, errors };
  if (size < headerSize) return { ok: false, points: 0, remainder: size, errors: ['파일이 헤더보다 작다'] };
  const body = size - headerSize;
  const points = Math.floor(body / POINT_BYTES);
  const diff = size - POINT_BYTES * points;
  if (body % POINT_BYTES !== 0) errors.push(`점 수가 정수가 아니다 (본문 ${body} B, 나머지 ${body % POINT_BYTES} B)`);
  if (diff > headerSize) errors.push(`크기 − 27×점수 = ${diff} B 가 헤더 ${headerSize} B 를 초과한다`);
  return { ok: errors.length === 0, points, remainder: diff, errors };
}

/** checkPointFile 이 실패하면 예외를 던지고, 성공하면 점 수를 돌려준다. */
export function assertPointFile(size, headerSize = 0, label = 'file') {
  const r = checkPointFile(size, headerSize);
  if (!r.ok) throw new Error(`${label}: ${r.errors.join('; ')}`);
  return r.points;
}

/** assetsRoot 를 훑어 구간별 수준별 크기를 모은다: Map<구간(number), Map<수준, {size, file}>>. */
export async function collectSizes(assetsRoot) {
  const segs = new Map();
  for (const name of (await readdir(assetsRoot)).sort()) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const seg = Number(m[1]);
    const level = Number(m[2]);
    if (!LEVELS.includes(level)) continue;
    const { size } = await stat(path.join(assetsRoot, name));
    if (!segs.has(seg)) segs.set(seg, new Map());
    segs.get(seg).set(level, { size, file: name });
  }
  return segs;
}

export async function run({ skylensDir, outDir, commit, assetsRoot, headerSize = 0 }) {
  const root = assetsRoot ?? path.join(skylensDir, 'assets');
  const segs = await collectSizes(root);
  if (segs.size === 0) throw new Error(`자산 파일이 없다: ${root}`);
  const base = { unit: 'B', device: 'static', commit };
  const records = [];
  const totals = [];
  let pointsAll = 0;
  for (const seg of [...segs.keys()].sort((a, b) => a - b)) {
    const levels = segs.get(seg);
    const method = `seg=${seg}; stat of seg<N>_L<level>.bin; header=${headerSize}B`;
    let total = 0;
    for (const level of LEVELS) {
      const e = levels.get(level);
      if (!e) throw new Error(`구간 ${seg} 에 수준 ${level} 파일이 없다`);
      pointsAll += assertPointFile(e.size, headerSize, e.file);
      total += e.size;
      records.push({ ...base, metric: `asset_bytes.level_${level}`, value: e.size, method });
    }
    totals.push(total);
    records.push({ ...base, metric: 'asset_bytes.segment_total', value: total, method });
  }
  records.push({
    ...base, metric: 'asset_bytes.segment_total_mean',
    value: totals.reduce((a, b) => a + b, 0) / totals.length,
    method: `mean over ${totals.length} segments`, samples: totals,
  });
  records.push({ ...base, metric: 'asset_bytes.points_total', unit: 'count', value: pointsAll, method: '(size-header)/27 summed' });
  assertRecords(records);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'asset_bytes.json'), serialize(records));
  }
  return records;
}
