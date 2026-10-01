// tower_bytes 테스트: 중복 제거 집계(합성), 입력 검증 음성 테스트, 외부 호출 코드 부재,
// T01.5 판정(실제 녹화 TOWER_RECORDING 에서 기준 건물 수 ±1%; 없으면 skip=미달).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { run, summarize, countBuildings, parseRecording } from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOTAL = 37; // 합성 입력 크기. 판정 기준값과 무관하다.

function feature(id) {
  return { type: 'Feature', id, properties: { height: 10 + (id % 40) }, geometry: { type: 'Point', coordinates: [127 + id * 1e-5, 37] } };
}

/** TOTAL 동을 7개 응답에 쪼개고 응답 사이에 중복 id 를 섞는다. 일부 본문은 문자열이다. */
function synth() {
  const entries = [];
  const chunk = Math.ceil(TOTAL / 7);
  for (let c = 0; c < 7; c++) {
    const start = c * chunk;
    const end = Math.min(TOTAL, start + chunk);
    const features = [];
    for (let id = start; id < end; id++) features.push(feature(id));
    if (c > 0) for (let id = start - 3; id < start; id++) features.push(feature(id)); // 이전 조각과 겹침
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

test('중복 제거 집계: 합성 건물 수', () => {
  assert.equal(countBuildings(synth()), 37);
});

test('summarize 집계', () => {
  const s = summarize(synth());
  assert.equal(s.building_count, 37);
  assert.equal(s.building_bytes, 7 * 1000 + 21 + 10);
  assert.equal(s.dem_bytes, 7500);
  assert.equal(s.request_count, 7 + 1 + 2 + 1 + 1);
});

test('run 이 계약을 만족하는 Record[] 반환', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-'));
  const rec = join(dir, 'rec.jsonl');
  await writeFile(rec, synth().map((e) => JSON.stringify(e)).join('\n') + '\n');
  const out = await run({ outDir: join(dir, 'out'), commit: 'abcdef1', inputs: { towerRecording: rec } });
  assertRecords(out);
  assert.equal(out.find((r) => r.metric === 'tower_bytes.building_count').value, 37);
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

async function tmpRec(text) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-neg-'));
  const p = join(dir, 'neg.jsonl');
  await writeFile(p, text);
  return p;
}
const ok = '{"kind":"dem","bytes":10}';
const runWith = async (text) => run({ commit: 'abcdef1', inputs: { towerRecording: await tmpRec(text) } });

test('inputs.towerRecording 없으면 throw', async () => {
  await assert.rejects(run({ commit: 'abcdef1', inputs: {} }), /towerRecording/);
  await assert.rejects(run({ commit: 'abcdef1' }), /towerRecording/);
});

test('음성: bytes 음수는 줄 번호·파일명 포함 오류', async () => {
  await assert.rejects(runWith(`${ok}\n\n{"kind":"dem","bytes":-500}\n`), (e) => /neg\.jsonl/.test(e.message) && /3번째 줄/.test(e.message) && /bytes/.test(e.message));
});

test('음성: bytes 문자열·소수, kind 불허', async () => {
  await assert.rejects(runWith(`${ok}\n{"kind":"dem","bytes":"500"}`), /2번째 줄.*bytes/);
  await assert.rejects(runWith('{"kind":"dem","bytes":1.5}'), /1번째 줄.*bytes/);
  await assert.rejects(runWith('{"kind":"video","bytes":5}'), /1번째 줄.*kind/);
});

test('음성: null·배열 줄은 원래 줄 번호로 실패', async () => {
  await assert.rejects(runWith(`\n\n${ok}\nnull\n`), /4번째 줄.*객체/);
  await assert.rejects(runWith(`${ok}\n[1]`), /2번째 줄.*객체/);
  await assert.rejects(runWith(`${ok}\n\n\nnot json`), /4번째 줄이 JSON/);
});

test('음성: 빈 녹화는 throw', async () => {
  await assert.rejects(runWith(''), /0개/);
  await assert.rejects(runWith('\n  \n'), /0개/);
  assert.throws(() => parseRecording('\n'), /0개/);
});

test('null feature 는 건물에서 제외', () => {
  const body = { type: 'FeatureCollection', features: [null, feature(1), feature(1), null] };
  assert.equal(countBuildings([{ kind: 'building', bytes: 1, body }]), 1);
});

// T01.5 판정: 실제 녹화가 있을 때만. 기대값 6,191 은 여기서만 쓴다.
const REAL = process.env.TOWER_RECORDING;
test('T01.5 판정: 녹화 응답에서 6,191 ±1% 재현', { skip: REAL ? false : '미달: 실제 녹화 없음' }, async () => {
  const out = await run({ commit: 'abcdef1', inputs: { towerRecording: REAL } });
  const n = out.find((r) => r.metric === 'tower_bytes.building_count').value;
  assert.ok(n >= 6191 * 0.99 && n <= 6191 * 1.01, `건물 수 ${n}`);
});
