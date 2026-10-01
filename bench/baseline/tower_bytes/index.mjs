// 관제탑 건물·지형 요청 수와 바이트 집계.
// 녹화된 응답(JSON Lines)만 읽는다. 네트워크 호출은 하지 않는다.
// 녹화 한 줄: {url, kind:'building'|'dem'|'imagery'|'other', status, bytes, body?}
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireInput } from '../../../contracts/inputs/index.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const DEVICE = 'recorded';
const METHOD = 'har-jsonl-aggregate';

const KINDS = ['building', 'dem', 'imagery', 'other'];

/** 녹화 한 항목을 검사한다. 원래 줄 번호(빈 줄 포함)를 오류에 넣는다. */
function validateEntry(e, lineNo, name) {
  const where = `${name} ${lineNo}번째 줄`;
  if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${where}: 항목이 객체가 아니다`);
  if (!KINDS.includes(e.kind)) throw new Error(`${where}: kind 가 허용값(${KINDS.join('|')})이 아니다: ${JSON.stringify(e.kind)}`);
  if (!Number.isInteger(e.bytes) || e.bytes < 0) throw new Error(`${where}: bytes 가 0 이상 정수가 아니다: ${JSON.stringify(e.bytes)}`);
}

/** JSON Lines 텍스트를 항목 배열로 바꾼다. 빈 줄은 건너뛰되 줄 번호는 원본 기준. 항목 0개면 throw. */
export function parseRecording(text, name = '녹화') {
  const entries = [];
  text.split('\n').forEach((raw, idx) => {
    const l = raw.trim();
    if (!l) return;
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      throw new Error(`${name} ${idx + 1}번째 줄이 JSON 이 아니다`);
    }
    validateEntry(e, idx + 1, name);
    Object.defineProperty(e, 'line', { value: idx + 1, enumerable: false });
    if (e.kind === 'building' && !isFailed(e)) featuresOf(e, name); // 파싱 실패를 줄 번호와 함께 즉시 드러낸다
    entries.push(e);
  });
  if (entries.length === 0) throw new Error(`${name}: 항목이 0개다`);
  return entries;
}

/** status 가 정수이고 2xx 가 아니면 실패 응답이다. status 가 없는 항목은 실패로 세지 않는다. */
function isFailed(e) {
  return Number.isInteger(e.status) && (e.status < 200 || e.status >= 300);
}

/** 2xx 건물 응답의 features. 본문 문자열이 JSON 이 아니면 줄 번호와 함께 throw. */
function featuresOf(e, name = '녹화') {
  let b = e.body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      const where = e.line ? `${name} ${e.line}번째 줄` : `${name} 건물 응답`;
      throw new Error(`${where}: 건물 응답 본문이 JSON 이 아니다 (status ${e.status})`);
    }
  }
  return b && b.type === 'FeatureCollection' && Array.isArray(b.features) ? b.features : [];
}

/** 건물 응답 본문의 features 에서 중복 id 를 제거한 건물 수. id 없는 feature 는 각각 1동으로 센다. */
export function countBuildings(entries) {
  const ids = new Set();
  let anonymous = 0;
  for (const e of entries) {
    if (e.kind !== 'building' || isFailed(e)) continue; // 실패 응답은 건물을 더하지 않는다
    for (const f of featuresOf(e)) {
      if (f === null || f === undefined) continue; // null feature 는 건물이 아니다
      const id = (f.id ?? (f.properties && f.properties.id));
      if (id === undefined || id === null) anonymous += 1;
      else ids.add(String(id));
    }
  }
  return ids.size + anonymous;
}

/** 종류별 요청 수·바이트와 건물 수를 집계한다. */
export function summarize(entries) {
  const bytesOf = (e) => e.bytes;
  const sumBytes = (kind) => entries.filter((e) => e.kind === kind).reduce((s, e) => s + bytesOf(e), 0);
  return {
    request_count: entries.length,
    total_bytes: entries.reduce((s, e) => s + bytesOf(e), 0),
    building_count: countBuildings(entries),
    building_bytes: sumBytes('building'),
    dem_bytes: sumBytes('dem'),
    imagery_bytes: sumBytes('imagery'),
    building_requests: entries.filter((e) => e.kind === 'building').length,
    dem_requests: entries.filter((e) => e.kind === 'dem').length,
    failed_responses: entries.filter(isFailed).length,
  };
}

export async function run({ outDir, commit, inputs } = {}) {
  // 녹화는 필수 입력이다. 없으면 throw, 합성으로 대체하지 않는다.
  const path = requireInput(inputs, 'towerRecording');
  const entries = parseRecording(await readFile(path, 'utf8'), path);
  const s = summarize(entries);
  const rec = (metric, value, unit) => ({ metric: `tower_bytes.${metric}`, value, unit, device: DEVICE, method: METHOD, commit });
  const records = assertRecords([
    rec('building_count', s.building_count, 'count'),
    rec('building_bytes', s.building_bytes, 'B'),
    rec('dem_bytes', s.dem_bytes, 'B'),
    rec('imagery_bytes', s.imagery_bytes, 'B'),
    rec('total_bytes', s.total_bytes, 'B'),
    rec('request_count', s.request_count, 'count'),
    rec('building_requests', s.building_requests, 'count'),
    rec('dem_requests', s.dem_requests, 'count'),
    rec('failed_responses', s.failed_responses, 'count'),
  ]);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'tower_bytes.json'), JSON.stringify(records, null, 2) + '\n');
  }
  return records;
}
