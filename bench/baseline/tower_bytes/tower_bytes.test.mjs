// tower_bytes 테스트: 합성 건물 6,191동 재현, 외부 호출 코드 부재, 계약 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { run, summarize, countBuildings } from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOTAL = 6191;

function feature(id) {
  return { type: 'Feature', id, properties: { height: 10 + (id % 40) }, geometry: { type: 'Point', coordinates: [127 + id * 1e-5, 37] } };
}

/** 6,191동을 7개 응답에 쪼개고 응답 사이에 중복 id 를 섞는다. 일부 본문은 문자열이다. */
function synth() {
  const entries = [];
  const chunk = Math.ceil(TOTAL / 7);
  for (let c = 0; c < 7; c++) {
    const start = c * chunk;
    const end = Math.min(TOTAL, start + chunk);
    const features = [];
    for (let id = start; id < end; id++) features.push(feature(id));
    if (c > 0) for (let id = start - 50; id < start; id++) features.push(feature(id)); // 이전 조각과 겹침
    const body = { type: 'FeatureCollection', features };
    entries.push({ url: `https://x.invalid/b/${c}`, kind: 'building', status: 200, bytes: 1000 + c, body: c % 2 ? JSON.stringify(body) : body });
  }
  entries.push({ url: 'https://x.invalid/b/fail', kind: 'building', status: 500, bytes: 10 });
  entries.push({ url: 'https://x.invalid/dem/1', kind: 'dem', status: 200, bytes: 5000 });
  entries.push({ url: 'https://x.invalid/dem/2', kind: 'dem', status: 200, bytes: 2500 });
  entries.push({ url: 'https://x.invalid/img/1', kind: 'imagery', status: 200, bytes: 700 });
  entries.push({ url: 'https://x.invalid/o', kind: 'other', status: 200, bytes: 5 });
  return entries;
}

test('합성 건물 수가 정확히 6191', () => {
  assert.equal(countBuildings(synth()), 6191);
});

test('summarize 집계', () => {
  const s = summarize(synth());
  assert.equal(s.building_count, 6191);
  assert.equal(s.building_bytes, 7 * 1000 + 21 + 10);
  assert.equal(s.dem_bytes, 7500);
  assert.equal(s.request_count, 7 + 1 + 2 + 1 + 1);
});

test('run 이 계약을 만족하는 Record[] 반환', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-'));
  const rec = join(dir, 'rec.jsonl');
  await writeFile(rec, synth().map((e) => JSON.stringify(e)).join('\n') + '\n');
  const out = await run({ skylensDir: dir, outDir: join(dir, 'out'), commit: 'abcdef1', recording: rec });
  assertRecords(out);
  assert.equal(out.find((r) => r.metric === 'tower_bytes.building_count').value, 6191);
  assert.equal(out.find((r) => r.metric === 'tower_bytes.dem_bytes').value, 7500);
});

test('소스에 외부 호출 코드 없음', async () => {
  const src = await readFile(join(here, 'index.mjs'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bfetch\s*\(/);
  assert.doesNotMatch(code, /from\s+['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/);
  assert.doesNotMatch(code, /import\s*\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/);
  assert.doesNotMatch(code, /require\s*\(/);
  assert.doesNotMatch(code, /XMLHttpRequest|WebSocket/);
});
