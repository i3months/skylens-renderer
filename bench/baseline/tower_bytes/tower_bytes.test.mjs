// tower_bytes 테스트: 중복 제거 집계(합성), 입력 검증 음성 테스트, 외부 호출 코드 부재,
// 실제 녹화 재현(SKYLENS_DIR/tower_recording.jsonl; 없으면 skip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { run, summarize, countBuildings, parseRecording } from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOTAL = 37; // 합성 입력 크기.

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
  assert.equal(s.failed_responses, 1);
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

test('building 2xx 본문이 잘린 JSON 이면 줄 번호 포함 throw', async () => {
  const bad = '{"kind":"building","status":200,"bytes":9,"body":"{\\"type\\":\\"FeatureColl"}';
  await assert.rejects(runWith(`${ok}\n\n${bad}\n`), (e) => /neg\.jsonl/.test(e.message) && /3번째 줄/.test(e.message) && /JSON/.test(e.message));
  assert.throws(() => countBuildings([{ kind: 'building', status: 200, bytes: 1, body: '{"type":"FeatureColl' }]), /JSON/);
});

test('building 비 2xx 는 건물 0동·failed_responses 로 집계, 오류 없음', async () => {
  const bad = '{"kind":"building","status":500,"bytes":9,"body":"{\\"type\\":\\"FeatureColl"}';
  const notFound = '{"kind":"dem","status":404,"bytes":3}';
  const out = await runWith(`${bad}\n${notFound}\n${ok}\n`);
  const val = (m) => out.find((r) => r.metric === `tower_bytes.${m}`).value;
  assert.equal(val('building_count'), 0);
  assert.equal(val('failed_responses'), 2);
  assert.equal(val('request_count'), 3);
});

// 실제 녹화가 있을 때만: SKYLENS_DIR/tower_recording.jsonl.
const DIR = process.env.SKYLENS_DIR;
const REAL = DIR ? join(DIR, 'tower_recording.jsonl') : null;
const realSkip = REAL && existsSync(REAL) ? false : 'SKYLENS_DIR/tower_recording.jsonl 없음';
test('실제 녹화 응답에서 건물 수 집계', { skip: realSkip }, async () => {
  const out = await run({ commit: 'abcdef1', inputs: { towerRecording: REAL } });
  const n = out.find((r) => r.metric === 'tower_bytes.building_count').value;
  assert.ok(Number.isInteger(n) && n > 0, `건물 수 ${n}`);
});

// 손계산 기준 녹화: 건물 3개 응답(고유 id 1,2,3 + 중복 1 + id 없는 2동 + properties.id 7 + null),
// 실패 건물 1, dem 2(100+200), imagery 1(40), other 1(5).
function handEntries() {
  const f = (o) => ({ type: 'Feature', geometry: null, properties: {}, ...o });
  const col = (features) => ({ type: 'FeatureCollection', features });
  return [
    { kind: 'building', status: 200, bytes: 1000, body: col([f({ id: 1 }), f({ id: 2 }), f({})]) },
    { kind: 'building', status: 200, bytes: 2000, body: JSON.stringify(col([f({ id: 2 }), f({ id: 3 }), f({}), f({ properties: { id: 7 } }), null])) },
    { kind: 'building', status: 200, bytes: 300, body: col([f({ properties: { id: 7 } }), f({ id: 1 })]) },
    { kind: 'building', status: 503, bytes: 9 },
    { kind: 'dem', status: 200, bytes: 100 },
    { kind: 'dem', status: 200, bytes: 200 },
    { kind: 'imagery', status: 200, bytes: 40 },
    { kind: 'other', status: 200, bytes: 5 },
  ];
}

test('손계산: 모든 지표 정확값', () => {
  const s = summarize(handEntries());
  // 고유 id {1,2,3,7} 4동 + id 없는 2동 = 6동
  assert.equal(s.building_count, 6);
  assert.equal(s.building_bytes, 1000 + 2000 + 300 + 9);
  assert.equal(s.dem_bytes, 300);
  assert.equal(s.imagery_bytes, 40);
  assert.equal(s.total_bytes, 3309 + 300 + 40 + 5);
  assert.equal(s.request_count, 8);
  assert.equal(s.building_requests, 4);
  assert.equal(s.dem_requests, 2);
  assert.equal(s.failed_responses, 1);
});

test('손계산: run 레코드 값과 단위', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-hand-'));
  const rec = join(dir, 'h.jsonl');
  await writeFile(rec, handEntries().map((e) => JSON.stringify(e)).join('\n'));
  const out = await run({ commit: 'abcdef1', inputs: { towerRecording: rec } });
  const got = Object.fromEntries(out.map((r) => [r.metric, [r.value, r.unit]]));
  assert.deepEqual(got, {
    'tower_bytes.building_count': [6, 'count'],
    'tower_bytes.building_bytes': [3309, 'B'],
    'tower_bytes.dem_bytes': [300, 'B'],
    'tower_bytes.imagery_bytes': [40, 'B'],
    'tower_bytes.total_bytes': [3654, 'B'],
    'tower_bytes.request_count': [8, 'count'],
    'tower_bytes.building_requests': [4, 'count'],
    'tower_bytes.dem_requests': [2, 'count'],
    'tower_bytes.failed_responses': [1, 'count'],
  });
});

test('id 없는 feature 는 각각 1동, properties.id 는 id 로 병합', () => {
  const body = { type: 'FeatureCollection', features: [{ type: 'Feature' }, { type: 'Feature' }, { type: 'Feature', properties: { id: 5 } }, { type: 'Feature', properties: { id: 5 } }] };
  assert.equal(countBuildings([{ kind: 'building', bytes: 1, body }]), 3);
});

test('음성: status "500" 문자열은 성공 처리하지 않고 줄 번호와 함께 throw', async () => {
  await assert.rejects(runWith(`${ok}\n{"kind":"building","status":"500","bytes":9}`), /2번째 줄.*status/);
  await assert.rejects(runWith('{"kind":"dem","status":200.5,"bytes":9}'), /1번째 줄.*status/);
});

test('객체 id 는 [object Object] 로 합쳐지지 않고 JSON 키로 구분', () => {
  const f = (id) => ({ type: 'Feature', id });
  const body = { type: 'FeatureCollection', features: [f({ a: 1 }), f({ a: 2 }), f({ a: 1 }), f('[object Object]')] };
  assert.equal(countBuildings([{ kind: 'building', bytes: 1, body }]), 3);
});
