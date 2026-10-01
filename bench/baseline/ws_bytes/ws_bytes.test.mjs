// 저장소 픽스처(fixtures/ws)를 재생해 고정 숫자와 비교한다. 기대값은 픽스처 파일에서 손으로 계산해 박았다.
// 구간 3: 1000+4000+16000+64000 = 85000, 구간 7: 2000+8000+32000+128000 = 170000 (서로 다른 시간 창에 흩어짐)
// 전체 = 120+400+85000+170000 = 255520, 초기(첫 first_frame 까지) = 120+400 = 520
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { run, summarize, replay } from './index.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'ws');
const TWO = join(FIX, 'two_segments.jsonl');
const EPOCH = join(FIX, 'epoch_ms.jsonl');

function tmp() {
  return mkdtempSync(join(tmpdir(), 'ws_bytes-'));
}
const get = (r, m) => r.find((x) => x.metric === m);

test('구간 2개 x 4수준: samples 정확히 2개, 값은 구간별 4프레임 합', async () => {
  const dir = tmp();
  try {
    const r = await run({ skylensDir: dir, outDir: dir, commit: 'abcdef0', inputs: { wsRecording: TWO } });
    assertRecords(r);
    const seg = get(r, 'ws_bytes.segment_total');
    assert.deepEqual(seg.samples, [85000, 170000]);
    assert.equal(seg.value, 127500);
    assert.equal(seg.unit, 'B');
    assert.equal(get(r, 'ws_bytes.total').value, 255520);
    assert.equal(get(r, 'ws_bytes.frames').value, 10);
    assert.equal(get(r, 'ws_bytes.initial').value, 520);
    // 시간 창 지표는 다른 이름: 트래픽 있는 창 7개
    assert.deepEqual(get(r, 'ws_bytes.window_1000ms').samples, [3520, 4000, 8000, 16000, 32000, 64000, 128000]);
    assert.deepEqual(r, await run({ skylensDir: dir, commit: 'abcdef0', inputs: { wsRecording: TWO } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outDir 에 ws_bytes.json 을 쓴다', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'nested', 'out');
    await run({ skylensDir: dir, outDir: out, commit: 'abcdef0', inputs: { wsRecording: TWO } });
    const parsed = JSON.parse(readFileSync(join(out, 'ws_bytes.json'), 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.records;
    assert.deepEqual(get(list, 'ws_bytes.segment_total').samples, [85000, 170000]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('t_ms=1.7e12 녹화도 1 s 안에 끝나고 값이 같다', async () => {
  const t0 = Date.now();
  const r = await run({ skylensDir: '.', commit: 'abcdef0', inputs: { wsRecording: EPOCH } });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [85000, 170000]);
  assert.equal(get(r, 'ws_bytes.window_1000ms').samples.length, 7);
});

test('inputs.wsRecording 이 없으면 throw', async () => {
  await assert.rejects(run({ skylensDir: '.', commit: 'abcdef0', inputs: {} }), /wsRecording/);
  await assert.rejects(run({ skylensDir: '.', commit: 'abcdef0' }), /wsRecording/);
});

test('summarize 기준값', () => {
  const s = summarize(replay(TWO));
  assert.deepEqual(s.segment_ids, [3, 7]);
  assert.deepEqual(s.by_kind, { hello: 120, first_frame: 400, points: 255000 });
});

const BASE = '{"t_ms":0,"dir":"rx","bytes":1,"kind":"first_frame"}\n';
function bad(text) {
  const dir = tmp();
  const p = join(dir, 'bad.jsonl');
  writeFileSync(p, text);
  return { dir, p };
}

test('형식 위반 줄은 파일명·줄 번호 포함 오류 (빈 줄 포함 원래 번호)', async () => {
  const cases = [
    [BASE + '\n{not json\n', /bad\.jsonl:3: 손상된 줄/],
    [BASE + '{"t_ms":0,"dir":"rx","bytes":1,"kind":"p","segment":0}\n', /bad\.jsonl:2: .*segment 와 level/],
    [BASE + '{"t_ms":0,"dir":"rx","bytes":1,"kind":"p","segment":0,"level":4}\n', /bad\.jsonl:2: .*level/],
    [BASE + '\n\n{"t_ms":0,"dir":"tx","bytes":1,"kind":"p","segment":0,"level":1}\n', /bad\.jsonl:4: .*rx/],
    [BASE + '{"t_ms":0,"dir":"rx","bytes":-1,"kind":"p"}\n', /bad\.jsonl:2: .*bytes/],
    [BASE + '{"t_ms":0,"dir":"rx","bytes":1,"kind":"p","segment":1.5,"level":1}\n', /bad\.jsonl:2: .*segment/],
  ];
  for (const [text, re] of cases) {
    const { dir, p } = bad(text);
    try {
      await assert.rejects(run({ skylensDir: dir, commit: 'abcdef0', inputs: { wsRecording: p } }), re);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('수준이 빠진 구간·first_frame 없음·segment 없음은 오류', async () => {
  const lv = (s, l) => `{"t_ms":1,"dir":"rx","bytes":10,"kind":"p","segment":${s},"level":${l}}\n`;
  const four = (s) => [0, 1, 2, 3].map((l) => lv(s, l)).join('');
  const cases = [
    [BASE + four(1) + lv(2, 0) + lv(2, 1), /구간 2: 수준 2,3/],
    [four(1), /first_frame/],
    [BASE, /segment 프레임이 없음/],
  ];
  for (const [text, re] of cases) {
    const { dir, p } = bad(text);
    try {
      await assert.rejects(run({ skylensDir: dir, commit: 'abcdef0', inputs: { wsRecording: p } }), re);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
