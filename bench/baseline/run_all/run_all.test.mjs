// run_all 테스트. 임시 디렉터리에 가짜 모듈을 만들어 modulesDir 로 주입한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runAll, MODULES } from './index.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const COMMIT = 'abc1234';
const NAMES = ['alpha', 'beta', 'gamma', 'delta']; // 성공 2, 던짐 1, 없음 1

let root;
let modulesDir;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'run_all-'));
  modulesDir = join(root, 'modules');
  const mk = async (name, body) => {
    await mkdir(join(modulesDir, name), { recursive: true });
    await writeFile(join(modulesDir, name, 'index.mjs'), body);
  };
  // alpha: 레코드 2개, outDir 에 파일을 쓴다
  await mk('alpha', `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function run({ outDir, commit }) {
  await writeFile(join(outDir, 'a.txt'), 'a');
  return [
    { metric: 'alpha.one', value: 1, unit: 'B', device: 'dev', method: 'fake', commit },
    { metric: 'alpha.two', value: 2, unit: 'ms', device: 'dev', method: 'fake', commit, samples: [1, 2, 3] },
  ];
}`);
  // beta: 레코드 1개
  await mk('beta', `export async function run({ commit }) {
  return [{ metric: 'beta.one', value: 10, unit: 'count', device: 'dev', method: 'fake', commit }];
}`);
  // gamma: 던진다
  await mk('gamma', `export async function run() { throw new Error('boom'); }`);
  // delta: 폴더 자체가 없다
});

after(() => rm(root, { recursive: true, force: true }));

const opts = (outDir) => ({ skylensDir: root, outDir, commit: COMMIT, modulesDir, modules: NAMES });

test('MODULES 는 계약의 8개 이름과 순서', () => {
  assert.deepEqual(MODULES, ['bundle_status', 'bundle_tower', 'asset_bytes', 'ws_bytes', 'tower_bytes', 'first_frame', 'heap', 'ref_images']);
});

test('성공 2 + 던짐 1 + 없음 1: 실패만 기록하고 나머지는 계속', async () => {
  const outDir = join(root, 'out1');
  const { summary, records, exitCode } = await runAll(opts(outDir));
  assert.equal(exitCode, 1);
  assert.equal(records.length, 3);
  assert.deepEqual(summary.ok, [{ module: 'alpha', records: 2 }, { module: 'beta', records: 1 }]);
  assert.equal(summary.failed.length, 2);
  assert.deepEqual(summary.failed.map((f) => [f.module, f.stage]), [['gamma', 'run'], ['delta', 'import']]);
  assert.equal(summary.failed[0].error, 'boom');
  assert.deepEqual(summary.skipped, []);
  assert.equal(summary.totalRecords, 3);

  const onDisk = JSON.parse(await readFile(join(outDir, 'summary.json'), 'utf8'));
  assert.deepEqual(onDisk, summary);
  const recs = JSON.parse(await readFile(join(outDir, 'records.json'), 'utf8'));
  assert.deepEqual(recs.map((r) => r.metric), ['alpha.one', 'alpha.two', 'beta.one']);
  // 모듈별 하위 폴더
  assert.equal(await readFile(join(outDir, 'alpha', 'a.txt'), 'utf8'), 'a');
  assert.ok((await readdir(outDir)).includes('beta'));
});

test('records.json 은 결정적: 두 번 실행해도 바이트 동일', async () => {
  await runAll(opts(join(root, 'det1')));
  await runAll(opts(join(root, 'det2')));
  const a = await readFile(join(root, 'det1', 'records.json'));
  const b = await readFile(join(root, 'det2', 'records.json'));
  assert.ok(a.equals(b));
  assert.ok(a.length > 0);
});

test('only / skip', async () => {
  const r1 = await runAll({ ...opts(join(root, 'only')), only: ['alpha'] });
  assert.equal(r1.exitCode, 0);
  assert.equal(r1.records.length, 2);
  assert.deepEqual(r1.summary.skipped, ['beta', 'gamma', 'delta']);
  const r2 = await runAll({ ...opts(join(root, 'skip')), skip: ['gamma', 'delta'] });
  assert.equal(r2.exitCode, 0);
  assert.equal(r2.records.length, 3);
  await assert.rejects(runAll({ ...opts(join(root, 'bad')), only: ['nope'] }), /unknown module nope/);
});

test('잘못된 레코드를 낸 모듈은 failed, 레코드는 제외', async () => {
  await mkdir(join(modulesDir, 'badrec'), { recursive: true });
  await writeFile(join(modulesDir, 'badrec', 'index.mjs'), `export async function run() { return [{ metric: 'X', value: 1 }]; }`);
  const { summary, records, exitCode } = await runAll({ ...opts(join(root, 'badrec')), modules: ['alpha', 'badrec'] });
  assert.equal(exitCode, 1);
  assert.equal(records.length, 2);
  assert.equal(summary.failed[0].module, 'badrec');
  assert.match(summary.failed[0].error, /record 0/);
});

test('CLI: 실패 시 종료코드 1, 전부 성공 시 0, 인자 누락 시 2', async () => {
  // CLI 는 MODULES 8개 이름을 쓰므로 그 이름으로 가짜 모듈 폴더를 따로 만든다.
  const dir = join(root, 'cli_modules');
  for (const name of MODULES) {
    if (name === 'heap') continue; // 없음
    await mkdir(join(dir, name), { recursive: true });
    const body = name === 'ws_bytes'
      ? `export async function run() { throw new Error('boom'); }`
      : `export async function run({ commit }) { return [{ metric: '${name}.n', value: 1, unit: 'count', device: 'd', method: 'm', commit }]; }`;
    await writeFile(join(dir, name, 'index.mjs'), body);
  }
  const base = ['--skylens-dir', root, '--commit', COMMIT, '--modules-dir', dir, '--dist-dir', join(root, 'prebuilt_dist')];
  const out = join(root, 'cli_out');
  const bad = spawnSync(process.execPath, [CLI, ...base, '--out', out], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  const s = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'));
  assert.equal(s.ok.length, 6);
  assert.deepEqual(s.failed.map((f) => f.module), ['ws_bytes', 'heap']);
  assert.equal(s.totalRecords, 6);

  const good = spawnSync(process.execPath, [CLI, ...base, '--out', join(root, 'cli_out2'), '--skip', 'ws_bytes,heap'], { encoding: 'utf8' });
  assert.equal(good.status, 0);
  const only = spawnSync(process.execPath, [CLI, ...base, '--out', join(root, 'cli_out3'), '--only', 'asset_bytes'], { encoding: 'utf8' });
  assert.equal(only.status, 0);
  assert.equal(JSON.parse(await readFile(join(root, 'cli_out3', 'summary.json'), 'utf8')).totalRecords, 1);

  const missing = spawnSync(process.execPath, [CLI, '--out', out], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
});

// 가짜 모듈 8개: bundle_status 는 받은 inputs 를 got.json 에 기록(echo), ref_images 는 pointsPath 가 없으면 throw
async function mkInputsModules() {
  const dir = join(root, 'inputs_modules');
  const contract = new URL('../../../contracts/inputs/index.mjs', import.meta.url).href;
  for (const name of MODULES) {
    await mkdir(join(dir, name), { recursive: true });
    const body = name === 'ref_images'
      ? `import { requireInput } from '${contract}';
export async function run({ commit, inputs }) { requireInput(inputs, 'pointsPath'); return [{ metric: 'ref.n', value: 1, unit: 'count', device: 'd', method: 'm', commit }]; }`
      : `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function run({ outDir, commit, inputs, skylensDir }) {
  await writeFile(join(outDir, 'got.json'), JSON.stringify({ inputs, skylensDir }));
  return [{ metric: '${name}.n', value: 1, unit: 'count', device: 'd', method: 'm', commit }];
}`;
    await writeFile(join(dir, name, 'index.mjs'), body);
  }
  return dir;
}

test('runAll: inputs 가 모듈에 그대로 전달된다', async () => {
  const dir = await mkInputsModules();
  const inputs = { pointsPath: '/p.ply', wsRecording: '/w.jsonl', distDir: '/d', anchor: { lat: 1.5, lon: 2.5, alt: 3 } };
  const out = join(root, 'in_out');
  await runAll({ skylensDir: root, outDir: out, commit: COMMIT, modulesDir: dir, inputs });
  const got = JSON.parse(await readFile(join(out, 'bundle_status', 'got.json'), 'utf8'));
  assert.deepEqual(got.inputs, inputs);
  assert.equal(got.skylensDir, root);
  // inputs 생략 시 빈 객체
  const out2 = join(root, 'in_out2');
  await runAll({ skylensDir: root, outDir: out2, commit: COMMIT, modulesDir: dir, buildDist: async ({ skylensDir, workDir }) => `${skylensDir}|${workDir}` });
  // distDir 가 없으면 run_all 이 빌드한 결과를 넘긴다(빌드 작업 폴더는 outDir/_build).
  assert.deepEqual(JSON.parse(await readFile(join(out2, 'bundle_status', 'got.json'), 'utf8')).inputs, { distDir: `${root}|${join(out2, '_build')}` });
});

test('runAll: 빌드가 실패하면 dist 모듈 4개만 build 단계 failed, 나머지는 계속', async () => {
  const dir = await mkInputsModules();
  const out = join(root, 'build_fail');
  const { summary, exitCode } = await runAll({ skylensDir: root, outDir: out, commit: COMMIT, modulesDir: dir,
    inputs: { pointsPath: '/p.ply' }, buildDist: async () => { throw new Error('npm ci 실패'); } });
  assert.deepEqual(summary.failed.map((f) => [f.module, f.stage]), [['bundle_status', 'build'], ['bundle_tower', 'build'], ['first_frame', 'build'], ['heap', 'build']]);
  assert.equal(summary.ok.length, 4);
  assert.equal(exitCode, 1);
});

test('CLI: 점군 경로가 없으면 ref_images 는 failed(종료코드 1), 있으면 전달되어 0', async () => {
  const dir = await mkInputsModules();
  const base = ['--skylens-dir', root, '--commit', COMMIT, '--modules-dir', dir, '--dist-dir', join(root, 'prebuilt_dist')];
  const out = join(root, 'cli_in1');
  const bad = spawnSync(process.execPath, [CLI, ...base, '--out', out], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  const s = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'));
  assert.equal(s.ok.length, 7);
  assert.equal(s.totalRecords, 7);
  assert.deepEqual(s.failed.map((f) => [f.module, f.stage]), [['ref_images', 'run']]);
  assert.match(s.failed[0].error, /input missing: pointsPath/);

  const out2 = join(root, 'cli_in2');
  const good = spawnSync(process.execPath, [CLI, ...base, '--out', out2, '--points', '/x/a.ply', '--ws-recording', '/x/w.jsonl',
    '--tower-recording', '/x/t.jsonl', '--dist-dir', '/x/dist', '--anchor-lat', '37.5', '--anchor-lon', '-127.25', '--anchor-alt', '12'], { encoding: 'utf8' });
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(await readFile(join(out2, 'summary.json'), 'utf8')).ok.length, 8);
  const got = JSON.parse(await readFile(join(out2, 'bundle_status', 'got.json'), 'utf8'));
  assert.deepEqual(got.inputs, {
    pointsPath: '/x/a.ply', wsRecording: '/x/w.jsonl', towerRecording: '/x/t.jsonl', distDir: '/x/dist',
    anchor: { lat: 37.5, lon: -127.25, alt: 12 },
  });
});

test('CLI: 앵커 일부만 주거나 숫자가 아니면 종료코드 2', () => {
  const base = [CLI, '--skylens-dir', root, '--commit', COMMIT, '--out', join(root, 'cli_bad')];
  const a = spawnSync(process.execPath, [...base, '--anchor-lat', '1'], { encoding: 'utf8' });
  assert.equal(a.status, 2);
  assert.match(a.stderr, /셋 다/);
  const b = spawnSync(process.execPath, [...base, '--anchor-lat', 'x', '--anchor-lon', '1', '--anchor-alt', '2'], { encoding: 'utf8' });
  assert.equal(b.status, 2);
  assert.match(b.stderr, /숫자/);
});

test('runAll: 멈춘 모듈은 timeout 으로 기록하고 records.json 은 작성, 나머지는 계속', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ra-to-'));
  const body = (r) => `export async function run() { ${r} }`;
  await mkdir(join(dir, 'hang'), { recursive: true });
  await mkdir(join(dir, 'fine'), { recursive: true });
  await writeFile(join(dir, 'hang', 'index.mjs'), body('return new Promise(() => {});'));
  await writeFile(join(dir, 'fine', 'index.mjs'), body('return [];'));
  const out = join(dir, 'out');
  const { summary, exitCode } = await runAll({ skylensDir: dir, outDir: out, commit: COMMIT, modulesDir: dir, modules: ['hang', 'fine'], moduleTimeoutMs: 300 });
  assert.equal(exitCode, 1);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].module, 'hang');
  assert.equal(summary.failed[0].stage, 'timeout');
  assert.deepEqual(summary.ok.map((o) => o.module), ['fine']);
  assert.equal((await readFile(join(out, 'records.json'), 'utf8')).trim(), '[]');
});

test('runAll: 빌드 타임아웃은 dist 모듈에 timeout 단계로 기록', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ra-bt-'));
  const buildDist = async () => { throw Object.assign(new Error('x'), { stage: 'timeout' }); };
  const { summary } = await runAll({ skylensDir: dir, outDir: join(dir, 'o'), commit: COMMIT, modulesDir: dir, modules: ['bundle_status'], buildDist });
  assert.equal(summary.failed[0].stage, 'timeout');
});
