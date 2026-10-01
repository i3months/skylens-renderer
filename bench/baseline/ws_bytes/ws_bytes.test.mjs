// 합성 녹화를 테스트 안에서 만들어 재생 결과를 고정 숫자와 비교한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { run, summarize, replay } from './index.mjs';

// 바이트 합: 120+400+80+1000+50+300 = 1950, 초기(첫 first_frame 까지) = 120+400 = 520
const FRAMES = [
  { t_ms: 0, dir: 'tx', bytes: 120, kind: 'hello' },
  { t_ms: 200, dir: 'rx', bytes: 400, kind: 'first_frame' },
  { t_ms: 900, dir: 'rx', bytes: 80, kind: 'delta' },
  { t_ms: 1500, dir: 'rx', bytes: 1000, kind: 'tile' },
  { t_ms: 3200, dir: 'tx', bytes: 50, kind: 'ack' },
  { t_ms: 3300, dir: 'rx', bytes: 300, kind: 'delta' },
];

function tmpRecording(text) {
  const dir = mkdtempSync(join(tmpdir(), 'ws_bytes-'));
  const path = join(dir, 'rec.jsonl');
  writeFileSync(path, text);
  return { dir, path };
}

test('두 번 재생해도 합계가 같고 기준값과 일치', async () => {
  const { dir, path } = tmpRecording(FRAMES.map((f) => JSON.stringify(f)).join('\n') + '\n');
  try {
    const a = summarize(replay(path));
    const b = summarize(replay(path));
    assert.deepEqual(a, b);
    assert.equal(a.total_bytes, 1950);
    assert.equal(a.frame_count, 6);
    assert.equal(a.initial_bytes, 520);
    assert.deepEqual(a.by_kind, { hello: 120, first_frame: 400, delta: 380, tile: 1000, ack: 50 });
    assert.deepEqual(a.segments, [600, 1000, 0, 350]);
    const r1 = await run({ skylensDir: dir, outDir: dir, commit: 'abcdef0', recording: path });
    const r2 = await run({ skylensDir: dir, outDir: dir, commit: 'abcdef0', recording: path });
    assert.deepEqual(r1, r2);
    assertRecords(r1);
    const get = (m) => r1.find((r) => r.metric === m);
    assert.equal(get('ws_bytes.total').value, 1950);
    assert.equal(get('ws_bytes.total').unit, 'B');
    assert.equal(get('ws_bytes.frames').value, 6);
    assert.equal(get('ws_bytes.frames').unit, 'count');
    assert.equal(get('ws_bytes.initial').value, 520);
    assert.equal(get('ws_bytes.segment_total').value, 487.5);
    assert.deepEqual(get('ws_bytes.segment_total').samples, [600, 1000, 0, 350]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('손상된 줄은 오류', () => {
  const { dir, path } = tmpRecording(JSON.stringify(FRAMES[0]) + '\n{not json\n');
  try {
    assert.throws(() => replay(path), /:2: 손상된 줄/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('형식이 틀린 프레임은 오류', () => {
  assert.throws(() => summarize([{ t_ms: 0, dir: 'up', bytes: 1, kind: 'x' }]), /dir/);
  assert.throws(() => summarize([{ t_ms: 0, dir: 'rx', bytes: -1, kind: 'x' }]), /bytes/);
});

test('first_frame 이 없으면 run 은 오류', async () => {
  const { dir, path } = tmpRecording(JSON.stringify(FRAMES[0]) + '\n');
  try {
    await assert.rejects(run({ skylensDir: dir, outDir: dir, commit: 'abcdef0', recording: path }), /first_frame/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
