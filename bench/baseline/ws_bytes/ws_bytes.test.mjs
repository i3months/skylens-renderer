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
import { run, summarize, replay, toProtocolLevel, MAX_LEVEL } from './index.mjs';

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

test('t_ms=1.7e12 녹화도 값이 같다 (시각 크기와 무관)', async () => {
  const r = await run({ skylensDir: '.', commit: 'abcdef0', inputs: { wsRecording: EPOCH } });
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
  assert.deepEqual({ ...s.by_kind }, { hello: 120, first_frame: 400, points: 255000 });
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
    [BASE + '{"t_ms":0,"dir":"rx","bytes":1,"kind":"p","segment":0,"level":31}\n', /bad\.jsonl:2: .*level/],
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

test('first_frame 없음·segment 없음·미완 구간만 있음은 오류', async () => {
  const lv = (s, l) => `{"t_ms":1,"dir":"rx","bytes":10,"kind":"p","segment":${s},"level":${l}}\n`;
  const four = (s) => [0, 1, 2, 3].map((l) => lv(s, l)).join('');
  const cases = [
    [four(1), /first_frame/],
    [BASE, /segment 프레임이 없음/],
    [BASE + lv(2, 0) + lv(2, 1), /미완 구간만/],
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

async function runText(text, extra = {}) {
  const { dir, p } = bad(text);
  try {
    return await run({ skylensDir: dir, commit: 'abcdef0', inputs: { wsRecording: p, ...(extra.topLevel === undefined ? {} : { wsTopLevel: extra.topLevel }) } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const fr = (s, l, bytes, extra = '') =>
  `{"t_ms":1,"dir":"rx","bytes":${bytes},"kind":"p","segment":${s},"level":${l}${extra}}\n`;
const F = (segment, level, bytes, resend) => ({ t_ms: 0, dir: 'rx', bytes, kind: 'p', segment, level, ...(resend ? { resend } : {}) });

test('수준 {0,3} 만 있는 구간: 실패 없이 받은 수준 합과 건너뛴 수준 [2,3] (프로토콜 번호) 기록', async () => {
  const r = await runText(BASE + fr(1, 0, 10) + fr(1, 1, 20) + fr(1, 2, 40) + fr(1, 3, 80) + fr(2, 0, 5) + fr(2, 3, 50));
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [150, 55]);
  assert.deepEqual(get(r, 'ws_bytes.levels_skipped').samples, [0, 2]);
  assert.equal(get(r, 'ws_bytes.levels_skipped').value, 2);
  assert.deepEqual(get(r, 'ws_bytes.levels_received').samples, [4, 2]);
  assert.deepEqual(get(r, 'ws_bytes.segment_levels_mask').samples, [15, 9]);
  const s = summarize([F(1, 3, 80), F(2, 0, 5), F(2, 3, 50)]);
  assert.deepEqual(s.segment_levels_skipped, [[1, 2, 3], [2, 3]]);
  assert.deepEqual(s.segment_levels, [[4], [1, 4]]);
});

test('최고 수준 하나만 받은 구간은 아래 수준 전부가 건너뜀', () => {
  const s = summarize([F(4, 3, 9)]);
  assert.deepEqual(s.segments, [9]);
  assert.deepEqual(s.segment_levels_skipped, [[1, 2, 3]]);
  assert.equal(s.trailing_segment, null);
});

test('녹화 끝의 미완 구간은 segment_total 에서 제외하고 따로 기록', async () => {
  const r = await runText(BASE + fr(1, 0, 10) + fr(1, 3, 80) + fr(2, 0, 5) + fr(2, 1, 7));
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [90]);
  assert.equal(get(r, 'ws_bytes.trailing_segment_bytes').value, 12);
  assert.equal(get(r, 'ws_bytes.total').value, 1 + 10 + 80 + 5 + 7);
  const s = summarize([F(1, 3, 80), F(2, 0, 5), F(2, 1, 7)]);
  assert.deepEqual(s.trailing_segment, { id: 2, bytes: 12, levels: [1, 2] });
});

test('재전송 프레임은 합에 넣지 않고 별도 지표, 표시 없는 같은 수준 프레임은 분할로 합산', async () => {
  const r = await runText(
    BASE +
      fr(1, 0, 10) +
      fr(1, 3, 30) +
      fr(1, 3, 50) + // split frame (no resend mark): summed
      fr(1, 0, 10, ',"resend":true') + // snapshot resend: not summed
      fr(1, 3, 80, ',"resend":true'),
  );
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [90]);
  assert.equal(get(r, 'ws_bytes.resend_bytes').value, 90);
  assert.equal(get(r, 'ws_bytes.total').value, 1 + 10 + 30 + 50 + 10 + 80);
});

test('원본 없이 재전송만 있으면 그것이 유일한 사본이라 합에 넣는다 (여러 회차는 한 회차만)', () => {
  const one = summarize([F(1, 2, 40, true)]);
  assert.deepEqual(one.segments, [40]);
  assert.equal(one.resend_bytes, 0);
  // 다른 수준 프레임이 끼면 별개 회차: 첫 회차만 합, 둘째 회차는 resend_bytes
  const two = summarize([F(1, 2, 40, true), F(1, 3, 7), F(1, 2, 40, true)]);
  assert.deepEqual(two.segments, [47]);
  assert.equal(two.resend_bytes, 40);
  assert.equal(two.total_bytes, 87);
  // 녹화 전체에서 바로 이어진 같은 (구간,수준) resend 는 한 회차의 분할 프레임 (두 프레임 합 80)
  const run1 = summarize([F(1, 2, 40, true), F(1, 2, 40, true)]);
  assert.deepEqual(run1.segments, [80]);
  assert.equal(run1.resend_bytes, 0);
  // 다른 구간·비구간 프레임이 끼어도 다른 회차: 40 B 재전송 두 회차는 40
  const apart = summarize([F(1, 2, 40, true), { t_ms: 0, dir: 'rx', bytes: 3, kind: 'ping' }, F(1, 2, 40, true)]);
  assert.deepEqual(apart.segments, [40]);
  assert.equal(apart.resend_bytes, 40);
});

test('원본 없는 relay 재생 두 번: 재생마다 구간당 한 회차라 segments [40,30], resend_bytes 70', async () => {
  const frames = [F(1, 2, 40, true), F(2, 2, 30, true), F(1, 2, 40, true), F(2, 2, 30, true)];
  const s = summarize(frames);
  assert.deepEqual(s.segment_ids, [1, 2]);
  assert.deepEqual(s.segments, [40, 30]);
  assert.equal(s.resend_bytes, 70);
  assert.equal(s.total_bytes, 140);
  assert.equal(s.stale_levels, 0);
  const r = await runText(BASE + frames.map((f) => fr(f.segment, f.level, f.bytes, ',"resend":true')).join(''));
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [40, 30]);
  assert.equal(get(r, 'ws_bytes.resend_bytes').value, 70);
});

test('resend 뒤에 온 같은 수준 원본은 stale 이 아니고 resend 가 재전송 바이트', () => {
  // [resend L1 7, 원본 L1 7, 원본 L2 1]: 원본 7+1 = 8, resend 7
  const s = summarize([F(1, 1, 7, true), F(1, 1, 7), F(1, 2, 1)]);
  assert.equal(s.stale_levels, 0);
  assert.equal(s.stale_bytes, 0);
  assert.equal(s.resend_bytes, 7);
  assert.deepEqual(s.segments, [8]);
  assert.deepEqual(s.segment_levels, [[2, 3]]);
  // 더 높은 수준 resend 뒤의 낮은 수준 원본도 stale 이 아님
  const t = summarize([F(1, 2, 9, true), F(1, 0, 4)]);
  assert.equal(t.stale_levels, 0);
  assert.deepEqual(t.segments, [13]);
});

test('바이트 합계가 safe integer 를 넘으면 오류', async () => {
  const big = Number.MAX_SAFE_INTEGER;
  assert.throws(() => summarize([F(1, 2, big), F(2, 2, big)]), /safe integer/);
  // 구간 하나·창 하나에 모인 경우도 같음
  assert.throws(() => summarize([F(1, 2, big), F(1, 2, 1)]), /safe integer/);
  assert.throws(() => summarize([{ t_ms: 0, dir: 'rx', bytes: big, kind: 'p' }, { t_ms: 0, dir: 'rx', bytes: big, kind: 'p' }]), /safe integer/);
  await assert.rejects(runText(BASE + fr(1, 2, big) + fr(2, 2, big)), /safe integer/);
  // 경계: 합이 정확히 2^53-1 이면 통과
  assert.equal(summarize([F(1, 2, big - 1), F(1, 2, 1)]).total_bytes, big);
});

test('resend 형식 위반은 오류', () => {
  assert.throws(() => summarize([{ ...F(1, 0, 1), resend: 'y' }]), /resend/);
  assert.throws(() => summarize([{ t_ms: 0, dir: 'rx', bytes: 1, kind: 'p', resend: true }]), /resend/);
});

test('수준 번호 변환: 내부 0..3 은 프로토콜 1..4', () => {
  assert.deepEqual([0, 1, 2, 3].map(toProtocolLevel), [1, 2, 3, 4]);
});

// ---- 도착 순서·수준 수 설정·완결 판정 ----
const T3 = { topLevel: 3 };

test('[3, 1(표시 없음)] 은 stale 1, [1, 3] 은 stale 0 이고 건너뜀은 같다', () => {
  const late = summarize([F(1, 3, 80), F(1, 1, 20)], T3);
  assert.equal(late.stale_levels, 1);
  // stale 프레임(20 B)은 받은 수준이 아니므로 수준 1 은 건너뜀 [1,2,3] (프로토콜 번호)
  assert.deepEqual(late.segment_levels_skipped, [[1, 2, 3]]);
  assert.deepEqual(late.segments, [80]);
  assert.equal(late.stale_bytes, 20);
  assert.equal(late.total_bytes, 100);
  const ok = summarize([F(1, 1, 20), F(1, 3, 80)], T3);
  assert.equal(ok.stale_levels, 0);
  assert.deepEqual(ok.segment_levels_skipped, [[1, 3]]);
});

test('연속 분할 프레임은 stale 0, 다른 수준이 끼면 앞 수준과 뒤 수준 모두 stale', () => {
  const split = summarize([F(1, 0, 5), F(1, 3, 30), F(1, 3, 50), F(1, 3, 20)], T3);
  assert.equal(split.stale_levels, 0);
  assert.deepEqual(split.segments, [105]);
  const broken = summarize([F(1, 3, 30), F(1, 1, 7), F(1, 3, 50)], T3);
  assert.equal(broken.stale_levels, 2);
  const dup = summarize([F(1, 0, 5), F(1, 1, 6), F(1, 0, 5)], { topLevel: 1 });
  assert.equal(dup.stale_levels, 1);
});

test('다른 구간 프레임이 사이에 끼어도 구간별 연속이면 분할, resend 는 stale 이 아님', () => {
  const s = summarize([F(1, 3, 30), F(2, 3, 9), F(1, 3, 50), F(1, 3, 4, true), F(1, 3, 8, true)], T3);
  assert.equal(s.stale_levels, 0);
  assert.deepEqual(s.segments, [80, 9]);
  assert.equal(s.resend_bytes, 12);
});

test('stale_levels·stale_bytes 지표가 레코드에 나온다', async () => {
  const r = await runText(BASE + fr(1, 2, 10) + fr(1, 0, 4) + fr(1, 2, 10));
  assert.equal(get(r, 'ws_bytes.stale_levels').value, 2);
  assert.equal(get(r, 'ws_bytes.stale_levels').unit, 'count');
  // stale 프레임 = 늦은 수준 0 (4 B) + 끼어든 뒤 다시 온 수준 2 (10 B)
  const sb = get(r, 'ws_bytes.stale_bytes');
  assert.equal(sb.value, 14);
  assert.equal(sb.unit, 'B');
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [10]);
  assert.equal(get(r, 'ws_bytes.total').value, 1 + 24);
});

test('stale 프레임은 구간 도착 순서를 바꾸지 않는다: 완결 구간의 늦은 프레임 뒤에도 미완 구간이 trailing', async () => {
  // [1:0, 1:1, 1:2, 2:0, 1:0(stale)]: 구간 1 완결(1+2+4), 구간 2 는 수준 0 만(8)이고 원본 기준 마지막 도착
  const frames = [F(1, 0, 1), F(1, 1, 2), F(1, 2, 4), F(2, 0, 8), F(1, 0, 16)];
  const s = summarize(frames);
  assert.equal(s.stale_levels, 1);
  assert.deepEqual(s.trailing_segment, { id: 2, bytes: 8, levels: [1] });
  assert.deepEqual(s.segments, [7]);
  const r = await runText(BASE + frames.map((f) => fr(f.segment, f.level, f.bytes)).join(''));
  assert.equal(get(r, 'ws_bytes.trailing_segment_bytes').value, 8);
  assert.equal(get(r, 'ws_bytes.stale_bytes').value, 16);
});

test('구간 ID 와 도착 순서가 다르면 trailing 은 마지막 도착 구간', () => {
  // ID 9 는 완결, ID 2 는 수준 0 만 받고 마지막에 도착
  const a = summarize([F(9, 0, 1), F(9, 1, 2), F(9, 2, 4), F(2, 0, 8)]);
  assert.deepEqual(a.trailing_segment, { id: 2, bytes: 8, levels: [1] });
  assert.deepEqual(a.segment_ids, [9]);
  assert.deepEqual(a.segments, [7]);
  // ID 5 가 수준 0 만이고 먼저 도착, ID 2 가 완결로 마지막이면 trailing 없음, 5 는 미완이라 segments 에서 빠짐
  const b = summarize([F(5, 0, 3), F(2, 0, 1), F(2, 1, 2), F(2, 2, 4)]);
  assert.equal(b.trailing_segment, null);
  assert.deepEqual(b.segment_ids, [2]);
  assert.deepEqual(b.segments, [7]);
  assert.deepEqual(b.incomplete_segments, [{ id: 5, bytes: 3, levels: [1] }]);
});

test('미완 구간 목록은 ID 순이 아니라 도착 순서', () => {
  // 구간 7 → 2 → 5 순서로 미완, 그 뒤 구간 4 완결
  const s = summarize([F(7, 0, 1), F(2, 0, 2), F(5, 1, 4), F(4, 0, 8), F(4, 1, 8), F(4, 2, 8)]);
  assert.deepEqual(s.incomplete_segments.map((t) => t.id), [7, 2, 5]);
  assert.deepEqual(s.trailing_segments, []);
  assert.deepEqual(s.segment_ids, [4]);
  // 끝부분 미완 구간도 도착 순서: 9 → 3
  const t = summarize([F(4, 0, 8), F(4, 1, 8), F(4, 2, 8), F(9, 0, 1), F(3, 0, 2)]);
  assert.deepEqual(t.trailing_segments.map((x) => x.id), [9, 3]);
  assert.deepEqual(t.incomplete_segments.map((x) => x.id), [9, 3]);
  assert.equal(t.trailing_segment.id, 3);
});

test('3수준 녹화에서 0~2 를 다 받은 마지막 구간은 완결 (trailing null)', async () => {
  const r = await runText(BASE + fr(1, 0, 10) + fr(1, 1, 20) + fr(1, 2, 40) + fr(2, 0, 1) + fr(2, 1, 2) + fr(2, 2, 4));
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [70, 7]);
  assert.equal(get(r, 'ws_bytes.trailing_segment_bytes').value, 0);
  assert.equal(summarize([F(1, 0, 1), F(1, 1, 2), F(1, 2, 4)]).trailing_segment, null);
});

test('끝부분 미완 구간이 여럿이면 모두 분리, 구간 3 만 segments', async () => {
  const s = summarize([F(3, 0, 1), F(3, 1, 2), F(3, 2, 4), F(1, 0, 8), F(2, 0, 16)]);
  assert.deepEqual(s.segment_ids, [3]);
  assert.deepEqual(s.segments, [7]);
  assert.deepEqual(s.trailing_segments, [
    { id: 1, bytes: 8, levels: [1] },
    { id: 2, bytes: 16, levels: [1] },
  ]);
  assert.deepEqual(s.trailing_segment, { id: 2, bytes: 16, levels: [1] });
  const r = await runText(BASE + fr(3, 0, 1) + fr(3, 1, 2) + fr(3, 2, 4) + fr(1, 0, 8) + fr(2, 0, 16));
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [7]);
  assert.equal(get(r, 'ws_bytes.trailing_segment_bytes').value, 24);
});

test('final 필드가 있으면 그것으로 완결 판정 (수준 수 무관)', () => {
  const fin = (s, l, b, final) => ({ ...F(s, l, b), final });
  // 4수준 사다리: 구간 2 는 수준 0..2 를 받았지만 final 이 없어 미완
  const s = summarize([fin(1, 2, 5, false), fin(1, 3, 6, true), fin(2, 0, 1, false), fin(2, 1, 2, false), fin(2, 2, 4, false)]);
  assert.deepEqual(s.segment_ids, [1]);
  assert.deepEqual(s.trailing_segment, { id: 2, bytes: 7, levels: [1, 2, 3] });
  // 2수준 사다리: 수준 1 이 final
  const t = summarize([fin(1, 0, 1, false), fin(1, 1, 2, true)]);
  assert.equal(t.trailing_segment, null);
  assert.throws(() => summarize([{ ...F(1, 0, 1), final: 1 }]), /final/);
  assert.throws(() => summarize([{ t_ms: 0, dir: 'rx', bytes: 1, kind: 'p', final: true }]), /final/);
});

test('5수준 이상 녹화도 받고 topLevel 로 완결을 정한다', async () => {
  assert.ok(MAX_LEVEL >= 4);
  const levels = [0, 1, 2, 3, 4].map((l) => fr(1, l, 1 << l)).join('');
  const r = await runText(BASE + levels);
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [31]);
  assert.deepEqual(get(r, 'ws_bytes.levels_received').samples, [5]);
  assert.equal(summarize([F(1, 3, 1)], { topLevel: 4 }).trailing_segment.id, 1);
  assert.equal(summarize([F(1, 4, 1)], { topLevel: 4 }).trailing_segment, null);
  assert.throws(() => summarize([F(1, MAX_LEVEL + 1, 1)]), /level/);
  assert.throws(() => summarize([], { topLevel: -1 }), /topLevel/);
});

test('inputs.wsTopLevel 이 완결 판정에 쓰인다', async () => {
  const { dir, p } = bad(BASE + fr(1, 2, 10) + fr(2, 2, 5));
  try {
    const base = { skylensDir: dir, commit: 'abcdef0' };
    const r4 = await run({ ...base, inputs: { wsRecording: p, wsTopLevel: 3 } }).catch((e) => e);
    assert.match(String(r4.message), /미완 구간만/);
    const r2 = await run({ ...base, inputs: { wsRecording: p, wsTopLevel: 2 } });
    assert.deepEqual(get(r2, 'ws_bytes.segment_total').samples, [10, 5]);
    await assert.rejects(run({ ...base, inputs: { wsRecording: p, wsTopLevel: 1.5 } }), /wsTopLevel/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 건너뜀 ----
test('가운데 구간이 {0,1} 만 받으면 미완이라 segments 에서 빠지고, 완결 구간만 건너뜀 계산', () => {
  const s = summarize([F(1, 0, 1), F(1, 1, 2), F(1, 2, 4), F(1, 3, 8), F(2, 0, 16), F(2, 1, 32), F(3, 3, 64)], T3);
  assert.deepEqual(s.segment_ids, [1, 3]);
  assert.deepEqual(s.segment_levels_skipped, [[], [1, 2, 3]]);
  assert.deepEqual(s.segments, [15, 64]);
  assert.deepEqual(s.incomplete_segments, [{ id: 2, bytes: 48, levels: [1, 2] }]);
  assert.deepEqual(s.trailing_segments.map((t) => t.id), []);
});

test('건너뜀 표본은 구간별 [1,2,0] 이고 지표 value 는 합 3, 마지막 표본이 아님', async () => {
  const r = await runText(
    BASE +
      [[1, 0], [1, 2], [1, 3], [2, 0], [2, 3], [3, 0], [3, 1], [3, 2], [3, 3]].map(([s, l]) => fr(s, l, 1)).join(''),
    { topLevel: 3 },
  );
  assert.deepEqual(get(r, 'ws_bytes.levels_skipped').samples, [1, 2, 0]);
  assert.equal(get(r, 'ws_bytes.levels_skipped').value, 3);
});

test('재전송만으로 생긴 공백은 건너뜀에서 뺀다', () => {
  // 원본 수준 0 뒤에 재접속 스냅샷이 최고 수준만 다시 보냄
  const a = summarize([F(1, 0, 10), F(1, 3, 40, true)], T3);
  assert.deepEqual(a.segment_levels_skipped, [[]]);
  assert.deepEqual(a.segments, [50]);
  assert.deepEqual(a.segment_levels, [[1, 4]]);
  // 원본이 수준 2 까지 있으면 수준 1 의 공백은 여전히 건너뜀
  const b = summarize([F(1, 0, 10), F(1, 2, 20), F(1, 3, 40, true)], T3);
  assert.deepEqual(b.segment_levels_skipped, [[2]]);
});

// ---- 지표 이름 ----
test('kind 가 __proto__ 여도 by_kind 에서 사라지지 않는다', async () => {
  const frames = [
    { t_ms: 0, dir: 'rx', bytes: 5, kind: '__proto__' },
    { t_ms: 1, dir: 'rx', bytes: 7, kind: 'first_frame' },
    F(1, 2, 3),
  ];
  const s = summarize(frames);
  assert.equal(Object.keys(s.by_kind).length, 3);
  assert.equal(s.by_kind['__proto__'], 5);
  assert.equal(s.initial_bytes, 12);
  const dir = tmp();
  try {
    const p = join(dir, 'k.jsonl');
    writeFileSync(p, frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
    const r = await run({ skylensDir: dir, commit: 'abcdef0', inputs: { wsRecording: p } });
    assert.equal(get(r, 'ws_bytes.kind.__proto__').value, 5);
    assert.equal(get(r, 'ws_bytes.kind.first_frame').value, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('정규화하면 같은 이름이 되는 kind 는 오류', async () => {
  const lines = ['a-b', 'a_b'].map((kind, i) => `{"t_ms":${i},"dir":"rx","bytes":1,"kind":"${kind}"}\n`);
  await assert.rejects(runText(BASE + lines.join('') + fr(1, 2, 1)), /a-b.*a_b.*충돌/);
});

// ---- 저장소 픽스처 ----
test('픽스처 three_level_out_of_order: 손계산 값', async () => {
  // 구간 1(수준 0,1,2 = 10+20+40) → 구간 4(final, 1+2+4) → 구간 2(수준 0 만, 8) 순서로 도착
  const r = await run({
    skylensDir: '.',
    commit: 'abcdef0',
    inputs: { wsRecording: join(FIX, 'three_level_out_of_order.jsonl') },
  });
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [70, 7]);
  assert.equal(get(r, 'ws_bytes.trailing_segment_bytes').value, 8);
  assert.equal(get(r, 'ws_bytes.stale_levels').value, 0);
  assert.equal(get(r, 'ws_bytes.total').value, 1 + 70 + 7 + 8);
});

// ---- 미완 구간·재전송 회차·stale 바이트·topLevel 가정 ----
test('① 구간 1·2 가 수준 0 만이고 구간 3 이 완결이면 segments 는 구간 3 하나', async () => {
  // 손계산: 구간 3 = 2+4+12 = 18, 미완 1 = 10, 2 = 10
  const frames = [F(1, 0, 10), F(2, 0, 10), F(3, 0, 2), F(3, 1, 4), F(3, 2, 12)];
  const s = summarize(frames);
  assert.deepEqual(s.segment_ids, [3]);
  assert.deepEqual(s.segments, [18]);
  assert.deepEqual(s.incomplete_segments.map((t) => [t.id, t.bytes]), [[1, 10], [2, 10]]);
  assert.deepEqual(s.trailing_segments, []);
  assert.equal(s.trailing_segment, null);
  assert.equal(s.total_bytes, 38);
  const r = await runText(BASE + frames.map((f) => fr(f.segment, f.level, f.bytes)).join(''));
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [18]);
  assert.equal(get(r, 'ws_bytes.incomplete_segment_bytes').value, 20);
  assert.equal(get(r, 'ws_bytes.trailing_segment_bytes').value, 0);
});

test('② 원본 없는 20 B resend 4개 두 회차 + 수준2 5 B: segments [45], resend_bytes 40', () => {
  // 회차 1 = 수준 1 resend 20+20, 사이에 수준 2 원본 5, 회차 2 = 20+20
  const s = summarize([F(1, 1, 20, true), F(1, 1, 20, true), F(1, 2, 5), F(1, 1, 20, true), F(1, 1, 20, true)]);
  assert.deepEqual(s.segments, [45]);
  assert.equal(s.resend_bytes, 40);
  assert.equal(s.total_bytes, 85);
  assert.deepEqual(s.segment_levels, [[2, 3]]);
});

test('③ 수준2 뒤 수준0 stale: segment_levels 에 0 없음, stale 바이트는 total·windows·stale_bytes 에만', () => {
  const s = summarize([F(1, 2, 8), F(1, 0, 3)]);
  assert.deepEqual(s.segments, [8]);
  assert.deepEqual(s.segment_levels, [[3]]);
  assert.equal(s.stale_levels, 1);
  assert.equal(s.stale_bytes, 3);
  assert.equal(s.total_bytes, 11);
  assert.deepEqual(s.windows, [11]);
  assert.deepEqual(s.segment_levels_skipped, [[1, 2]]);
  // 수준 1·2 를 받은 뒤 수준 0 이 늦게 오면 0 은 받은 수준이 아니라 건너뜀 [1]
  const t = summarize([F(1, 1, 4), F(1, 2, 8), F(1, 0, 3)]);
  assert.deepEqual(t.segments, [12]);
  assert.deepEqual(t.segment_levels, [[2, 3]]);
  assert.deepEqual(t.segment_levels_skipped, [[1]]);
  assert.equal(t.stale_bytes, 3);
});

test('④ final 필드 없는 녹화에서 topLevel 기본값을 쓰면 method 에 topLevel 가정 경고', async () => {
  const r = await runText(BASE + fr(1, 0, 1) + fr(1, 1, 2) + fr(1, 2, 4));
  for (const x of r) assert.match(x.method, /topLevel 가정/);
  assert.equal(summarize([F(1, 2, 1)]).top_level_assumed, true);
  // wsTopLevel 을 주면 가정이 아님
  const r2 = await runText(BASE + fr(1, 2, 4), { topLevel: 2 });
  for (const x of r2) assert.doesNotMatch(x.method, /topLevel 가정/);
  // final 필드가 있으면 가정이 아님
  assert.equal(summarize([{ ...F(1, 2, 1), final: true }]).top_level_assumed, false);
  const r3 = await runText(BASE + fr(1, 2, 4, ',"final":true'));
  for (const x of r3) assert.doesNotMatch(x.method, /topLevel 가정/);
});

test('final 필드가 있는데 wsTopLevel 을 주면 무시했다는 사실을 method 에 남긴다', async () => {
  const text = BASE + fr(1, 0, 1, ',"final":false') + fr(1, 1, 2, ',"final":true');
  const r = await runText(text, { topLevel: 3 });
  // topLevel 3 이면 미완이었겠지만 final 로 완결
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [3]);
  for (const x of r) assert.match(x.method, /final 필드로 완결 판정, inputs\.wsTopLevel=3 무시/);
  assert.equal(summarize([{ ...F(1, 1, 2), final: true }], { topLevel: 3 }).top_level_ignored, true);
  // wsTopLevel 이 없으면 무시 문구도 없음
  const r2 = await runText(text);
  for (const x of r2) assert.doesNotMatch(x.method, /무시/);
  assert.equal(summarize([{ ...F(1, 1, 2), final: true }]).top_level_ignored, false);
  // final 이 없고 wsTopLevel 이 쓰이면 무시 문구 없음
  const r3 = await runText(BASE + fr(1, 2, 4), { topLevel: 2 });
  for (const x of r3) assert.doesNotMatch(x.method, /무시/);
});

test('bytes 가 safe integer 가 아니면 오류 (1e300)', async () => {
  assert.throws(() => summarize([{ ...F(1, 0, 1e300) }]), /bytes/);
  assert.throws(() => summarize([{ ...F(1, 0, 2 ** 53) }]), /bytes/);
  await assert.rejects(runText(BASE + '{"t_ms":0,"dir":"rx","bytes":1e300,"kind":"p"}\n'), /bad\.jsonl:2: .*bytes/);
  assert.equal(summarize([F(1, 2, Number.MAX_SAFE_INTEGER)]).segments[0], Number.MAX_SAFE_INTEGER);
});

// ---- 추월된 수준의 재전송·resend 전용 완결·재전송 뒤 분할 끊김 ----
test('원본 최고 수준보다 낮은 resend 전용 수준은 추월된 수준: 합·받은 수준에서 빼고 건너뜀', async () => {
  // [수준2 원본 final 10 B, 수준0 resend 99 B]: 받은 수준은 3 하나, 1·2 건너뜀, 99 B 는 재전송
  const frames = [{ ...F(1, 2, 10), final: true }, F(1, 0, 99, true)];
  const s = summarize(frames);
  assert.deepEqual(s.segment_ids, [1]);
  assert.deepEqual(s.segments, [10]);
  assert.deepEqual(s.segment_levels, [[3]]);
  assert.deepEqual(s.segment_levels_skipped, [[1, 2]]);
  assert.equal(s.resend_bytes, 99);
  assert.equal(s.stale_levels, 0);
  assert.equal(s.total_bytes, 109);
  const r = await runText(BASE + fr(1, 2, 10, ',"final":true') + fr(1, 0, 99, ',"resend":true'));
  assert.deepEqual(get(r, 'ws_bytes.segment_total').samples, [10]);
  assert.deepEqual(get(r, 'ws_bytes.levels_skipped').samples, [2]);
  assert.equal(get(r, 'ws_bytes.resend_bytes').value, 99);
  // final 필드가 없어도 같다
  const t = summarize([F(1, 2, 10), F(1, 0, 99, true)]);
  assert.deepEqual(t.segments, [10]);
  assert.deepEqual(t.segment_levels_skipped, [[1, 2]]);
  assert.equal(t.resend_bytes, 99);
  // 원본 최고 수준이 오르기 전에 온 resend 전용 낮은 수준은 추월 전 수신이라 받은 수준 (원본 [0, 2] 와 같은 취급)
  const before = summarize([F(1, 0, 99, true), F(1, 2, 10)]);
  assert.deepEqual(before.segments, [109]);
  assert.deepEqual(before.segment_levels, [[1, 3]]);
  assert.deepEqual(before.segment_levels_skipped, [[2]]);
  assert.equal(before.resend_bytes, 0);
  // 추월 전 회차가 있으면 그것이 사본, 추월 뒤 회차는 재전송
  const both = summarize([F(1, 0, 5, true), F(1, 2, 10), F(1, 0, 5, true)]);
  assert.deepEqual(both.segments, [15]);
  assert.equal(both.resend_bytes, 5);
});

test('원본 없이 final resend 프레임만 있으면 완결이 아니다 (완결은 원본 final 로만)', async () => {
  const s = summarize([{ ...F(1, 2, 99, true), final: true }]);
  assert.deepEqual(s.segment_ids, []);
  assert.deepEqual(s.segments, []);
  assert.equal(s.incomplete_segments.length, 1);
  assert.deepEqual(s.incomplete_segments[0], { id: 1, bytes: 99, levels: [3] });
  assert.deepEqual(s.resend_only_segments, [1]);
  await assert.rejects(runText(BASE + fr(1, 2, 99, ',"resend":true,"final":true')), /미완 구간만/);
  // 같은 구간에 final 원본이 오면 완결
  const t = summarize([{ ...F(1, 2, 99, true), final: true }, { ...F(1, 2, 99), final: true }]);
  assert.deepEqual(t.segments, [99]);
  assert.equal(t.resend_bytes, 99);
  assert.deepEqual(t.resend_only_segments, []);
});

test('resend 프레임 뒤의 같은 수준 원본은 분할 연속이 끊겨 stale', () => {
  // [L1 7, rL1 7, L1 7, L2 1]: 원본 L1 7 + L2 1 = 8, 셋째 프레임은 stale 7, 둘째는 재전송 7
  const s = summarize([F(1, 1, 7), F(1, 1, 7, true), F(1, 1, 7), F(1, 2, 1)]);
  assert.deepEqual(s.segments, [8]);
  assert.equal(s.stale_levels, 1);
  assert.equal(s.stale_bytes, 7);
  assert.equal(s.resend_bytes, 7);
  assert.equal(s.total_bytes, 22);
  assert.deepEqual(s.segment_levels, [[2, 3]]);
  // 다른 구간 resend 는 끊지 않는다 (구간별 분할: 7+7+1 = 15)
  const o = summarize([F(1, 1, 7), F(2, 1, 7, true), F(1, 1, 7), F(1, 2, 1)]);
  assert.equal(o.stale_levels, 0);
  assert.deepEqual(o.segment_ids, [1]);
  assert.deepEqual(o.segments, [15]);
});

test('[r40, r40] 은 한 회차 분할로 80 이지만 단일 구간 relay 반복 재생과 구분 불가라 method 에 적는다', async () => {
  const s = summarize([F(1, 2, 40, true), F(1, 2, 40, true)]);
  assert.deepEqual(s.segments, [80]);
  assert.equal(s.resend_merged_rounds, 1);
  assert.deepEqual(s.resend_only_segments, [1]);
  const r = await runText(BASE + fr(1, 2, 40, ',"resend":true') + fr(1, 2, 40, ',"resend":true'));
  const seg = get(r, 'ws_bytes.segment_total');
  assert.deepEqual(seg.samples, [80]);
  assert.match(seg.method, /한 회차의 분할로 합산.*구분 불가/);
  assert.match(seg.method, /resend 전용 구간 1개/);
  // 사이에 다른 프레임이 끼면 다른 회차라 모호성 없음 (40, 재전송 40)
  const apart = await runText(BASE + fr(1, 2, 40, ',"resend":true') + fr(2, 2, 3) + fr(1, 2, 40, ',"resend":true'));
  assert.deepEqual(get(apart, 'ws_bytes.segment_total').samples, [40, 3]);
  assert.equal(get(apart, 'ws_bytes.resend_bytes').value, 40);
  assert.doesNotMatch(get(apart, 'ws_bytes.segment_total').method, /구분 불가/);
  // 원본이 있는 수준의 연속 resend 는 모두 재전송이라 모호성 표기 없음
  const orig = await runText(BASE + fr(1, 2, 10) + fr(1, 2, 4, ',"resend":true') + fr(1, 2, 4, ',"resend":true'));
  assert.equal(get(orig, 'ws_bytes.resend_bytes').value, 8);
  for (const x of orig) assert.doesNotMatch(x.method, /구분 불가|resend 전용/);
});
