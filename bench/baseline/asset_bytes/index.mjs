// 자산 바이트 기준선: 구간(segment) × 수준(level) 별 점 파일 크기를 집계한다.
//
// 자산은 PLY(binary_little_endian, ASCII 헤더 + 점당 property 목록)다. 점당 바이트(stride)는
// 헤더 property 합으로 구하고, 기대값(ASSUMED_STRIDE = 27 B)과 같은지를 assumed_stride_matches(0/1)로 기록한다.
//
// 자산 위치 규약(contracts/inputs): <skylensDir>/res/static/demo/segments/seg<N>_step<5자리>.ply,
// step 00250/01000/03500/07000 = 수준 0..3 (STEP_LEVEL).
// 파일 크기는 형식 검사와 분리해 항상 기록한다. 문제(형식 위반, 누락 수준, 알 수 없는 step 파일)가 하나라도 있으면
// 파일별 바이트만 기록하고 합계·평균 같은 집계 레코드는 쓰지 않은 채 한꺼번에 던진다.
// 점 수·stride·헤더 길이는 PLY 헤더(parsePlyHeader)에서 읽고, `size − stride×N == 헤더 길이` 를 검사한다.
import { stat, open, mkdir, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';
import { parsePlyHeader } from '../../../contracts/ply/index.mjs';
import { STEP_LEVEL } from '../../../contracts/inputs/index.mjs';

// 27 B/점 은 renderer_basis §7-4 의 점 저장 형식(x y z f32×3 + 법선 nx ny nz f32×3 + 색 r g b u8×3 = 12+12+3)에서 온 기대값이다.
// 실제 데모 자산은 법선 없이 float32×14 = 56 B/점 인 PLY 라 이 형식에서 이탈한다(assumed_stride_matches = 0).
// 기대값에 맞추려고 측정을 바꾸지 않고, 실측 stride 와 이탈 사실을 method 에 그대로 적는다.
export const ASSUMED_STRIDE = 27;
export const LEVELS = [0, 1, 2, 3];
const NAME_RE = /^seg(\d+)_step(\d+)\.ply$/;
const HEADER_MAX = 1 << 20;

/** 헤더에서 "56 B/점 (float32×14)" 형태의 설명을 만든다(연속한 같은 타입은 묶는다). */
export function strideText(hdr) {
  const groups = [];
  for (const p of hdr.properties) {
    const last = groups[groups.length - 1];
    if (last && last.type === p.type) last.n += 1;
    else groups.push({ type: p.type, n: 1 });
  }
  const props = groups.map((g) => `${g.type}×${g.n}`).join(' + ');
  const rel = hdr.stride === ASSUMED_STRIDE
    ? `기대 ${ASSUMED_STRIDE} B 와 일치`
    : `기대 ${ASSUMED_STRIDE} B 와 불일치: renderer_basis §7-4 점 형식(xyz+법선+rgb) 이탈`;
  return `${hdr.stride} B/점 (${props}; ${rel})`;
}

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
 * 이름 패턴은 맞지만 STEP_LEVEL 에 없는 step 파일은 건너뛰되 unknownSteps 배열에 파일명을 담아 호출자가 보고하게 한다.
 */
export async function collectSizes(assetsRoot, unknownSteps = []) {
  const segs = new Map();
  for (const name of readdirSync(assetsRoot).sort()) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const seg = Number(m[1]);
    const level = STEP_LEVEL[Number(m[2])];
    if (level === undefined) { unknownSteps.push(name); continue; }
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
  const unknownSteps = [];
  const segs = await collectSizes(root, unknownSteps);
  if (segs.size === 0) throw new Error(`자산 파일이 없다: ${root}`);
  const base = { unit: 'B', device: 'static', commit };
  const records = [];
  const problems = unknownSteps.map((n) => `${n}: step 이 STEP_LEVEL(${Object.keys(STEP_LEVEL).join('/')})에 없어 집계에서 제외됨`);
  const aggregates = [];
  const levelTotals = new Map(LEVELS.map((l) => [l, 0]));
  const totals = [];
  let pointsAll = 0;
  const strides = new Map(); // stride -> property 요약
  let matchesAll = 1;
  for (const seg of [...segs.keys()].sort((a, b) => a - b)) {
    const levels = segs.get(seg);
    let total = 0;
    for (const level of LEVELS) {
      const e = levels.get(level);
      if (!e) { problems.push(`구간 ${seg} 에 수준 ${level} 파일이 없다`); continue; }
      // 바이트는 형식과 무관하게 항상 기록
      total += e.size;
      levelTotals.set(level, levelTotals.get(level) + e.size);
      let hdr = null;
      try {
        hdr = await readHeader(e.path);
      } catch (err) {
        problems.push(`${e.file}: ${err.message}`);
        matchesAll = 0;
      }
      const method = `seg=${seg} level=${level}; stat of ${e.file}; ${hdr ? `PLY ${strideText(hdr)} 실측` : 'PLY 헤더 읽기 실패'}`;
      records.push({ ...base, metric: `asset_bytes.level_${level}`, value: e.size, method });
      if (!hdr) continue;
      const chk = checkLayout(e.size, hdr);
      if (!chk.ok) problems.push(`${e.file}: ${chk.errors.join('; ')}`);
      else pointsAll += hdr.vertexCount;
      strides.set(hdr.stride, strideText(hdr));
      const matches = hdr.stride === ASSUMED_STRIDE ? 1 : 0;
      if (!matches) matchesAll = 0;
      records.push({ ...base, metric: `asset_bytes.stride_level_${level}`, value: hdr.stride, method });
      records.push({ ...base, unit: 'count', metric: `asset_bytes.assumed_stride_matches_level_${level}`, value: matches, method: `${method}; 기대 ${ASSUMED_STRIDE} B 와 일치하면 1` });
    }
    totals.push(total);
    aggregates.push({ ...base, metric: 'asset_bytes.segment_total', value: total, method: `seg=${seg}; 4수준 파일 크기 합` });
  }
  for (const level of LEVELS) {
    aggregates.push({ ...base, metric: `asset_bytes.level_${level}_total`, value: levelTotals.get(level), method: `수준 ${level} 의 ${segs.size}개 구간 파일 크기 합` });
  }
  aggregates.push({
    ...base, metric: 'asset_bytes.segment_total_mean',
    value: totals.reduce((a, b) => a + b, 0) / totals.length,
    method: `mean over ${totals.length} segments`, samples: totals,
  });
  aggregates.push({ ...base, unit: 'count', metric: 'asset_bytes.points_total', value: pointsAll, method: 'PLY 헤더 element vertex N 합 (레이아웃 검사 통과 파일만)' });
  if (strides.size === 1) {
    const [[stride, text]] = [...strides];
    aggregates.push({ ...base, metric: 'asset_bytes.stride', value: stride, method: `PLY 헤더 property 합: ${text}` });
  }
  aggregates.push({ ...base, unit: 'count', metric: 'asset_bytes.assumed_stride_matches', value: matchesAll, method: `모든 파일 stride 가 기대 ${ASSUMED_STRIDE} B 와 일치하면 1, 아니면 0` });
  if (!problems.length) records.push(...aggregates);
  assertRecords(records);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'asset_bytes.json'), serialize(records));
  }
  if (problems.length) throw new Error(`자산 형식 오류 (파일별 바이트만 기록됨, 집계 없음):\n${problems.join('\n')}`);
  return records;
}
