// 자산 바이트 기준선 (T01.3): 구간(segment) × 수준(level) 별 점 파일 크기를 집계한다.
//
// 실제 자산은 PLY(binary_little_endian, ASCII 헤더 + float32×14 = 56 B/점)다.
// 기존 가정(27 B/점)에서 56 B 로 이탈한다. 이탈 여부는 assumed_stride_matches(0/1)로 기록하고,
// 어느 입력 형식을 쓸지는 T03 에서 감독·사람이 결정한다.
//
// 자산 위치 규약(contracts/inputs): <skylensDir>/res/static/demo/segments/seg<N>_step<5자리>.ply,
// step 00250/01000/03500/07000 = 수준 0..3 (STEP_LEVEL).
// 바이트(파일 크기)는 형식 검사와 분리해 항상 기록한다. 형식 위반은 기록 뒤에 한꺼번에 던진다.
// 점 수·stride·헤더 길이는 PLY 헤더(parsePlyHeader)에서 읽고, `size − stride×N == 헤더 길이` 를 검사한다.
import { stat, open, mkdir, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';
import { parsePlyHeader } from '../../../contracts/ply/index.mjs';
import { STEP_LEVEL } from '../../../contracts/inputs/index.mjs';

export const ASSUMED_STRIDE = 27;
export const LEVELS = [0, 1, 2, 3];
const NAME_RE = /^seg(\d+)_step(\d+)\.ply$/;
const HEADER_MAX = 1 << 20;

/** 기본 자산 디렉터리. */
export function defaultAssetsRoot(skylensDir) {
  return path.join(skylensDir, 'res', 'static', 'demo', 'segments');
}

/**
 * 크기와 헤더 정보로 레이아웃을 검사한다: size − stride×N == headerBytes.
 * @returns {{ok:boolean, errors:string[]}}
 */
export function checkLayout(size, hdr) {
  const errors = [];
  const expected = hdr.headerBytes + hdr.stride * hdr.vertexCount;
  if (size !== expected) {
    errors.push(`크기 ${size} B ≠ 헤더 ${hdr.headerBytes} + stride ${hdr.stride} × N ${hdr.vertexCount} = ${expected} B`);
  }
  return { ok: errors.length === 0, errors };
}

/** 파일 앞부분에서 헤더를 읽는다(end_header 가 나올 때까지 확장). */
export async function readHeader(file) {
  const fh = await open(file, 'r');
  try {
    let len = 4096;
    for (;;) {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      try {
        return parsePlyHeader(buf.subarray(0, bytesRead));
      } catch (e) {
        if (/end_header not found/.test(e.message) && bytesRead === len && len < HEADER_MAX) { len *= 4; continue; }
        throw e;
      }
    }
  } finally { await fh.close(); }
}

/**
 * assetsRoot 를 훑어 Map<구간, Map<수준, {size, file}>> 를 만든다.
 * 구간 번호·수준이 중복되면(seg1/seg01, step00250/step0250) 던진다.
 */
export async function collectSizes(assetsRoot) {
  const segs = new Map();
  for (const name of readdirSync(assetsRoot).sort()) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const seg = Number(m[1]);
    const level = STEP_LEVEL[Number(m[2])];
    if (level === undefined) continue;
    const { size } = await stat(path.join(assetsRoot, name));
    if (!segs.has(seg)) segs.set(seg, new Map());
    const levels = segs.get(seg);
    if (levels.has(level)) {
      throw new Error(`중복 키: 구간 ${seg} 수준 ${level} — ${levels.get(level).file} 와 ${name}`);
    }
    levels.set(level, { size, file: name, path: path.join(assetsRoot, name) });
  }
  return segs;
}

export async function run({ skylensDir, outDir, commit, assetsRoot }) {
  const root = assetsRoot ?? defaultAssetsRoot(skylensDir);
  const segs = await collectSizes(root);
  if (segs.size === 0) throw new Error(`자산 파일이 없다: ${root}`);
  const base = { unit: 'B', device: 'static', commit };
  const records = [];
  const problems = [];
  const levelTotals = new Map(LEVELS.map((l) => [l, 0]));
  const totals = [];
  let pointsAll = 0;
  const strides = new Set();
  let matchesAll = 1;
  for (const seg of [...segs.keys()].sort((a, b) => a - b)) {
    const levels = segs.get(seg);
    let total = 0;
    for (const level of LEVELS) {
      const e = levels.get(level);
      if (!e) { problems.push(`구간 ${seg} 에 수준 ${level} 파일이 없다`); continue; }
      const method = `seg=${seg} level=${level}; stat of ${e.file}; PLY 56 B/점 실측 (기존 27 B 가정에서 이탈)`;
      // 바이트는 형식과 무관하게 항상 기록
      total += e.size;
      levelTotals.set(level, levelTotals.get(level) + e.size);
      records.push({ ...base, metric: `asset_bytes.level_${level}`, value: e.size, method });
      try {
        const hdr = await readHeader(e.path);
        const chk = checkLayout(e.size, hdr);
        if (!chk.ok) problems.push(`${e.file}: ${chk.errors.join('; ')}`);
        else pointsAll += hdr.vertexCount;
        strides.add(hdr.stride);
        const matches = hdr.stride === ASSUMED_STRIDE ? 1 : 0;
        if (!matches) matchesAll = 0;
        records.push({ ...base, metric: `asset_bytes.stride_level_${level}`, value: hdr.stride, method });
        records.push({ ...base, unit: 'count', metric: `asset_bytes.assumed_stride_matches_level_${level}`, value: matches, method: `${method}; 기대 ${ASSUMED_STRIDE} B 와 일치하면 1` });
      } catch (err) {
        problems.push(`${e.file}: ${err.message}`);
        matchesAll = 0;
      }
    }
    totals.push(total);
    records.push({ ...base, metric: 'asset_bytes.segment_total', value: total, method: `seg=${seg}; 4수준 파일 크기 합` });
  }
  for (const level of LEVELS) {
    records.push({ ...base, metric: `asset_bytes.level_${level}_total`, value: levelTotals.get(level), method: `수준 ${level} 의 ${segs.size}개 구간 파일 크기 합` });
  }
  records.push({
    ...base, metric: 'asset_bytes.segment_total_mean',
    value: totals.reduce((a, b) => a + b, 0) / totals.length,
    method: `mean over ${totals.length} segments`, samples: totals,
  });
  records.push({ ...base, unit: 'count', metric: 'asset_bytes.points_total', value: pointsAll, method: 'PLY 헤더 element vertex N 합 (레이아웃 검사 통과 파일만)' });
  const strideMethod = 'PLY 헤더 property 합; 실제 56 B(float32×14), 기존 27 B 가정에서 이탈';
  if (strides.size === 1) records.push({ ...base, metric: 'asset_bytes.stride', value: [...strides][0], method: strideMethod });
  records.push({ ...base, unit: 'count', metric: 'asset_bytes.assumed_stride_matches', value: matchesAll, method: `모든 파일 stride 가 기대 ${ASSUMED_STRIDE} B 와 일치하면 1, 아니면 0` });
  assertRecords(records);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'asset_bytes.json'), serialize(records));
  }
  if (problems.length) throw new Error(`자산 형식 오류 (바이트는 기록됨):\n${problems.join('\n')}`);
  return records;
}
