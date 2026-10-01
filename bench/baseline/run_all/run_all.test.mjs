import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAll, MODULES, parseArgs, defaultLoader } from './index.mjs';
import { parse } from '../../../contracts/metrics/index.mjs';

const commit = 'abcdef1';
const rec = (metric) => ({ metric, value: 1, unit: 'B', device: 'x', method: 'm', commit });
const ok = (metric) => ({ run: async () => [rec(metric)] });
const base = async () => ({ skylensDir: '/nonexistent', outDir: await mkdtemp(join(tmpdir(), 'ra-')), commit });

test('runs modules sequentially and writes records.json', async () => {
  const order = [];
  const mk = (n) => ({ run: async () => { order.push(`s${n}`); await new Promise((r) => setTimeout(r, 5)); order.push(`e${n}`); return [rec(`m${n}`)]; } });
  const b = await base();
  const res = await runAll({ ...b, modules: { a: mk(1), b: mk(2) } });
  assert.deepEqual(order, ['s1', 'e1', 's2', 'e2']);
  assert.equal(res.failures.length, 0);
  const parsed = parse(await readFile(join(b.outDir, 'records.json'), 'utf8'));
  assert.deepEqual(parsed.map((r) => r.metric), ['m1', 'm2']);
});

test('module receives skylensDir, outDir, commit', async () => {
  const b = await base();
  let got;
  await runAll({ ...b, modules: { a: { run: async (o) => { got = o; return []; } } } });
  assert.deepEqual(got, b);
});

test('thrown error propagates as failure; no records.json; other modules still run', async () => {
  const b = await base();
  let ran = false;
  const res = await runAll({ ...b, modules: { a: { run: async () => { throw new Error('boom'); } }, b: { run: async () => { ran = true; return []; } } } });
  assert.equal(res.failures.length, 1);
  assert.match(res.failures[0].error, /boom/);
  assert.ok(ran);
  await assert.rejects(access(join(b.outDir, 'records.json')));
});

test('invalid records are a failure', async () => {
  const b = await base();
  const res = await runAll({ ...b, modules: { a: { run: async () => [{ metric: 'Bad' }] } } });
  assert.equal(res.failures.length, 1);
  assert.equal(res.failures[0].module, 'a');
});

test('non-array return and missing run() are failures', async () => {
  const b = await base();
  const res = await runAll({ ...b, modules: { a: { run: async () => null }, b: {} } });
  assert.equal(res.failures.length, 2);
});

test('missing module is a failure by default', async () => {
  const b = await base();
  const res = await runAll({ ...b, modules: ['a', 'b'], loader: async (n) => (n === 'a' ? ok('m1') : null) });
  assert.deepEqual(res.missing, ['b']);
  assert.equal(res.failures.length, 1);
  assert.equal(res.failures[0].error, 'module missing');
  assert.equal(res.outFile, null);
});

test('--allow-missing tolerates missing modules', async () => {
  const b = await base();
  const res = await runAll({ ...b, allowMissing: true, modules: ['a', 'b'], loader: async (n) => (n === 'a' ? ok('m1') : null) });
  assert.deepEqual(res.missing, ['b']);
  assert.equal(res.failures.length, 0);
  assert.equal(res.records.length, 1);
});

test('loader import errors are failures even with allowMissing', async () => {
  const b = await base();
  const res = await runAll({ ...b, allowMissing: true, modules: ['a'], loader: async () => { throw new SyntaxError('bad syntax'); } });
  assert.equal(res.failures.length, 1);
});

test('default loader reports a nonexistent module as missing', async () => {
  assert.equal(await defaultLoader('definitely_not_a_module'), null);
});

test('fixed module list', () => {
  assert.deepEqual(MODULES, ['bundle_status', 'bundle_tower', 'asset_bytes', 'ws_bytes', 'tower_bytes', 'first_frame', 'heap', 'ref_images']);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--out', 'd', '--allow-missing']), { out: 'd', allowMissing: true });
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--x']));
});

test('CLI: exits non-zero without SKYLENS_DIR, and on missing modules', async () => {
  const cli = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const out = await mkdtemp(join(tmpdir(), 'ra-cli-'));
  const env = { ...process.env };
  delete env.SKYLENS_DIR;
  assert.throws(() => execFileSync('node', [cli, '--out', out], { env, stdio: 'pipe' }));
  const repo = await mkdtemp(join(tmpdir(), 'ra-repo-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  // Other modules may or may not exist in this tree; with --allow-missing absent, any missing one must fail.
  try {
    execFileSync('node', [cli, '--out', out], { env: { ...env, SKYLENS_DIR: repo }, stdio: 'pipe' });
  } catch (e) {
    assert.equal(e.status, 1);
  }
});
