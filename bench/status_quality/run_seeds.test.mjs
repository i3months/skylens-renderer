// runSeeds 계약 시험: 가짜 자식 스크립트로 정상·실패·시간 초과·동시 수 상한을 검증한다(실제 측정 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSeeds } from './run_seeds.mjs';

const dir = mkdtempSync(join(tmpdir(), 'run_seeds_test_'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

// 인자: 모드, 시드, (선택) 기록 파일
const child = join(dir, 'child.mjs');
writeFileSync(child, `
import { appendFileSync } from 'node:fs';
const [mode, seed, log] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (mode === 'ok') console.log('잡음\\n' + JSON.stringify({ seed: Number(seed) }));
else if (mode === 'empty') {}
else if (mode === 'text') console.log('JSON 이 아님');
else if (mode === 'crash') { console.error('폭발 사유'); process.exit(3); }
else if (mode === 'hang') await sleep(30000);
else if (mode === 'conc') {
  appendFileSync(log, '+\\n'); await sleep(150); appendFileSync(log, '-\\n');
  console.log(JSON.stringify({ seed: Number(seed) }));
}
`);

const run = (mode, extra = {}, seeds = [7]) =>
  runSeeds({ cli: child, argsFor: (s) => [mode, String(s), extra.log ?? ''], seeds, limit: 2, ...extra });

test('정상 JSON 을 시드별 Map 으로 돌려준다', async () => {
  const m = await run('ok', {}, [1, 2, 3]);
  assert.deepEqual([...m.keys()].sort(), [1, 2, 3]);
  assert.deepEqual(m.get(2), { seed: 2 });
});

test('빈 출력은 시드 번호를 적어 reject', async () => {
  await assert.rejects(run('empty'), /시드 7.*빈 출력/s);
});

test('JSON 아님은 시드 번호와 stdout 꼬리를 담아 reject', async () => {
  await assert.rejects(run('text'), (e) => /시드 7/.test(e.message) && /JSON 아님/.test(e.message) && e.message.includes('JSON 이 아님'));
});

test('비정상 종료는 시드 번호와 stderr 꼬리를 담아 reject', async () => {
  await assert.rejects(run('crash'), (e) => /시드 7/.test(e.message) && /비정상 종료/.test(e.message) && e.message.includes('폭발 사유'));
});

test('시간 초과는 시드 번호를 담아 reject', async () => {
  await assert.rejects(run('hang', { timeoutMs: 300 }), /시드 7.*시간 초과/s);
});

test('동시 실행 수가 limit 을 넘지 않는다', async () => {
  const log = join(dir, 'conc.log');
  writeFileSync(log, '');
  const m = await runSeeds({ cli: child, argsFor: (s) => ['conc', String(s), log], seeds: [1, 2, 3, 4, 5, 6], limit: 2 });
  assert.equal(m.size, 6);
  let cur = 0, max = 0;
  for (const c of readFileSync(log, 'utf8').trim().split('\n')) { cur += c === '+' ? 1 : -1; max = Math.max(max, cur); }
  assert.ok(max <= 2, `최대 동시 ${max}`);
  assert.ok(max >= 2, `병렬이 전혀 일어나지 않음(최대 ${max})`);
});
