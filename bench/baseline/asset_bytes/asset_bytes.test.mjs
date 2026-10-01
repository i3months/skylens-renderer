// PLY 자산 바이트 집계: 실제 /tmp/skylens 트리(있을 때)와 합성 픽스처로 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, checkLayout, collectSizes, defaultAssetsRoot } from './index.mjs';
import { parsePlyHeader } from '../../../contracts/ply/index.mjs';

const COMMIT = 'abcdef1234567';
const STEPS = ['00250', '01000', '03500', '07000'];

function plyBuf(n, { stride56 = true, declared = n, extraBody = 0 } = {}) {
  const props = stride56
    ? Array.from({ length: 14 }, (_, i) => `property float f${i}`)
    : ['x', 'y', 'z', 'nx', 'ny', 'nz'].map((p) => `property float ${p}`).concat(['red', 'green', 'blue'].map((p) => `property uchar ${p}`));
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${declared}\n${props.join('\n')}\nend_header\n`;
  return Buffer.concat([Buffer.from(head), Buffer.alloc((stride56 ? 56 : 27) * n + extraBody)]);
}

async function fixture(counts, opts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asset_bytes-'));
  const seg = defaultAssetsRoot(dir);
  await mkdir(seg, { recursive: true });
  for (const [s, pts] of Object.entries(counts)) {
    for (const [i, step] of STEPS.entries()) await writeFile(path.join(seg, `seg${s}_step${step}.ply`), plyBuf(pts[i], opts));
  }
  return { dir, seg };
}

test('checkLayout: size − stride×N == 헤더 길이', () => {
  const buf = plyBuf(3);
  const hdr = parsePlyHeader(buf);
  assert.equal(hdr.stride, 56);
  assert.equal(checkLayout(buf.length, hdr).ok, true);
  assert.equal(checkLayout(buf.length + 1, hdr).ok, false);
  assert.equal(checkLayout(buf.length - 56, hdr).ok, false);
});

test('run: 합성 56 B PLY, 수준별 합계·stride·matches', async () => {
  const f = await fixture({ 0: [1, 2, 3, 4], 1: [10, 20, 30, 40] });
  try {
    const recs = await run({ skylensDir: f.dir, outDir: path.join(f.dir, 'out'), commit: COMMIT });
    const get = (m) => recs.find((r) => r.metric === m);
    assert.equal(get('asset_bytes.stride').value, 56);
    assert.equal(get('asset_bytes.assumed_stride_matches').value, 0);
    assert.equal(get('asset_bytes.points_total').value, 110);
    // 헤더 길이는 N 자릿수에 따라 달라지므로 파일 길이로 기대값을 만든다(점 수는 위에서 고정)
    assert.equal(get('asset_bytes.level_0_total').value, plyBuf(1).length + plyBuf(10).length);
    assert.match(get('asset_bytes.stride').method, /56 B\/점 \(float×14/);
    assert.doesNotMatch(get('asset_bytes.stride').method, /27 B 가정/);
    // 구간별 합계와 평균: 두 구간의 크기가 달라야 첫 구간 값으로 대체한 변형이 드러난다
    const segTotals = recs.filter((r) => r.metric === 'asset_bytes.segment_total').map((r) => r.value);
    const seg0 = [1, 2, 3, 4].reduce((a, n) => a + plyBuf(n).length, 0);
    const seg1 = [10, 20, 30, 40].reduce((a, n) => a + plyBuf(n).length, 0);
    assert.notEqual(seg0, seg1);
    assert.deepEqual(segTotals, [seg0, seg1]);
    const mean = get('asset_bytes.segment_total_mean');
    assert.deepEqual(mean.samples, [seg0, seg1]);
    assert.equal(mean.value, (seg0 + seg1) / 2);
    assert.notEqual(mean.value, mean.samples[0]);
    assert.equal(JSON.parse(await readFile(path.join(f.dir, 'out', 'asset_bytes.json'), 'utf8')).length, recs.length);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('run: 27 B 스트라이드 PLY 는 matches 1', async () => {
  const f = await fixture({ 0: [1, 1, 1, 1] }, { stride56: false });
  try {
    const recs = await run({ skylensDir: f.dir, commit: COMMIT });
    assert.equal(recs.find((r) => r.metric === 'asset_bytes.stride').value, 27);
    assert.equal(recs.find((r) => r.metric === 'asset_bytes.assumed_stride_matches').value, 1);
    const m = recs.find((r) => r.metric === 'asset_bytes.stride').method;
    assert.match(m, /27 B\/점/);
    assert.doesNotMatch(m, /56/);
    assert.doesNotMatch(m, /불일치|이탈/);
    assert.doesNotMatch(recs.find((r) => r.metric === 'asset_bytes.level_0').method, /56/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('음성: 헤더 N 과 본문 크기가 어긋난 파일은 거부하되 바이트는 기록', async () => {
  const f = await fixture({ 0: [1, 1, 1, 1] });
  await writeFile(path.join(f.seg, 'seg0_step03500.ply'), plyBuf(5, { declared: 7 })); // 헤더 7점, 본문 5점
  const out = path.join(f.dir, 'out');
  try {
    await assert.rejects(run({ skylensDir: f.dir, outDir: out, commit: COMMIT }), /seg0_step03500\.ply/);
    const saved = JSON.parse(await readFile(path.join(out, 'asset_bytes.json'), 'utf8'));
    assert.equal(saved.find((r) => r.metric === 'asset_bytes.level_2').value, plyBuf(5).length);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('음성: 본문 뒤 잉여 바이트, 헤더 없는 파일, 누락 수준', async () => {
  const f = await fixture({ 0: [1, 1, 1, 1] });
  try {
    await writeFile(path.join(f.seg, 'seg0_step00250.ply'), plyBuf(1, { extraBody: 3 }));
    await assert.rejects(run({ skylensDir: f.dir, commit: COMMIT }), /seg0_step00250\.ply/);
    await writeFile(path.join(f.seg, 'seg0_step00250.ply'), Buffer.alloc(100));
    await assert.rejects(run({ skylensDir: f.dir, commit: COMMIT }), /seg0_step00250\.ply.*end_header/);
    await rm(path.join(f.seg, 'seg0_step07000.ply'));
    await assert.rejects(run({ skylensDir: f.dir, commit: COMMIT }), /수준 3/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('음성: 수준 누락 시 segment_total·평균 레코드를 쓰지 않는다', async () => {
  const f = await fixture({ 0: [1, 1, 1, 1] });
  const out = path.join(f.dir, 'out');
  try {
    await rm(path.join(f.seg, 'seg0_step07000.ply'));
    await assert.rejects(run({ skylensDir: f.dir, outDir: out, commit: COMMIT }), /수준 3/);
    const saved = JSON.parse(await readFile(path.join(out, 'asset_bytes.json'), 'utf8'));
    assert.equal(saved.some((r) => /segment_total|_total$|points_total/.test(r.metric)), false);
    assert.equal(saved.filter((r) => /^asset_bytes\.level_\d$/.test(r.metric)).length, 3);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('음성: 알 수 없는 step 파일은 경고 없이 빠지지 않고 던진다', async () => {
  const f = await fixture({ 0: [1, 1, 1, 1] });
  const out = path.join(f.dir, 'out');
  try {
    await writeFile(path.join(f.seg, 'seg0_step05000.ply'), plyBuf(1));
    const unknown = [];
    await collectSizes(f.seg, unknown);
    assert.deepEqual(unknown, ['seg0_step05000.ply']);
    await assert.rejects(run({ skylensDir: f.dir, outDir: out, commit: COMMIT }), /seg0_step05000\.ply.*STEP_LEVEL/);
    const saved = JSON.parse(await readFile(path.join(out, 'asset_bytes.json'), 'utf8'));
    assert.equal(saved.some((r) => r.metric === 'asset_bytes.segment_total'), false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('음성: 자산 디렉터리 없음/비어 있음은 던진다', async () => {
  await assert.rejects(run({ skylensDir: '/nonexistent', commit: COMMIT }));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asset_bytes-'));
  try {
    await mkdir(defaultAssetsRoot(dir), { recursive: true });
    await assert.rejects(run({ skylensDir: dir, commit: COMMIT }), /자산 파일이 없다/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('중복 키: seg1 과 seg01 은 던진다 (덮어쓰지 않음)', async () => {
  const f = await fixture({ 1: [1, 1, 1, 1] });
  try {
    await writeFile(path.join(f.seg, 'seg01_step00250.ply'), plyBuf(2));
    await assert.rejects(collectSizes(f.seg), /중복 키.*seg01_step00250\.ply|중복 키.*seg1_step00250\.ply/);
    await assert.rejects(run({ skylensDir: f.dir, commit: COMMIT }), /중복 키/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('중복 키: step00250 과 step0250 (같은 수준)은 던진다', async () => {
  const f = await fixture({ 0: [1, 1, 1, 1] });
  try {
    await writeFile(path.join(f.seg, 'seg0_step0250.ply'), plyBuf(2));
    await assert.rejects(run({ skylensDir: f.dir, commit: COMMIT }), /중복 키/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

const REAL = process.env.SKYLENS_DIR ?? '/tmp/skylens';
test('실제 데모 16개 파일: 수준별 합계·stride 56·matches 0', { skip: !existsSync(defaultAssetsRoot(REAL)) && '실제 skylens 트리 없음' }, async () => {
  const recs = await run({ skylensDir: REAL, commit: COMMIT });
  const get = (m) => recs.find((r) => r.metric === m).value;
  assert.equal(get('asset_bytes.level_0_total'), 473744);
  assert.equal(get('asset_bytes.level_1_total'), 1256960);
  assert.equal(get('asset_bytes.level_2_total'), 14170732);
  assert.equal(get('asset_bytes.level_3_total'), 26070736);
  assert.equal(get('asset_bytes.stride'), 56);
  assert.equal(get('asset_bytes.assumed_stride_matches'), 0);
  assert.equal(recs.filter((r) => /^asset_bytes\.level_\d$/.test(r.metric)).length, 16);
});
