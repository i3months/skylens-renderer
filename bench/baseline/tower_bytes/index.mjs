// 관제탑 건물·지형 요청 수와 바이트 집계 (T01.5).
// 녹화된 응답(JSON Lines)만 읽는다. 네트워크 호출은 하지 않는다.
// 녹화 한 줄: {url, kind:'building'|'dem'|'imagery'|'other', status, bytes, body?}
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const DEVICE = 'recorded';
const METHOD = 'har-jsonl-aggregate';

/** JSON Lines 텍스트를 항목 배열로 바꾼다. 빈 줄은 건너뛴다. */
export function parseRecording(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`녹화 ${i + 1}번째 줄이 JSON 이 아니다`);
      }
    });
}

function featuresOf(body) {
  let b = body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return [];
    }
  }
  return b && b.type === 'FeatureCollection' && Array.isArray(b.features) ? b.features : [];
}

/** 건물 응답 본문의 features 에서 중복 id 를 제거한 건물 수. id 없는 feature 는 각각 1동으로 센다. */
export function countBuildings(entries) {
  const ids = new Set();
  let anonymous = 0;
  for (const e of entries) {
    if (e.kind !== 'building') continue;
    for (const f of featuresOf(e.body)) {
      const id = f && (f.id ?? (f.properties && f.properties.id));
      if (id === undefined || id === null) anonymous += 1;
      else ids.add(String(id));
    }
  }
  return ids.size + anonymous;
}

/** 종류별 요청 수·바이트와 건물 수를 집계한다. */
export function summarize(entries) {
  const bytesOf = (e) => (Number.isFinite(e.bytes) ? e.bytes : 0);
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
  };
}

export async function run({ skylensDir, outDir, commit, recording } = {}) {
  const path = recording ?? join(skylensDir ?? '.', 'recordings', 'tower.jsonl');
  const entries = parseRecording(await readFile(path, 'utf8'));
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
  ]);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'tower_bytes.json'), JSON.stringify(records, null, 2) + '\n');
  }
  return records;
}
