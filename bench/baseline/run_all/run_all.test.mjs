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
  const base = ['--skylens-dir', root, '--commit', COMMIT, '--modules-dir', dir];
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
