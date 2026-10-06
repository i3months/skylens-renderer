// 공용 플래그 검사(flags.mjs)와 세 측정 스크립트의 명령줄 거부를 확인한다(F-491 ⑥).
// 스크립트는 인자 검사를 측정보다 먼저 하므로 거부 경로는 수백 ms 안에 끝난다. 거부되지 않으면 전체 측정이 돌아 시간 초과로 실패한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './flags.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const SPEC = { values: ['--only', '--json'], bools: ['--no-check'] };

test('parseFlags: 정상 인자', () => {
  const f = parseFlags(['--only', 'a,b', '--no-check', '--json', 'x.json'], SPEC);
  assert.equal(f.get('--only'), 'a,b');
  assert.equal(f.get('--json'), 'x.json');
  assert.ok(f.has('--no-check'));
  assert.equal(f.get('--no-check'), null);
  assert.equal(parseFlags([], SPEC).has('--only'), false);
  assert.equal(parseFlags(['--only', ''], SPEC).get('--only'), '');
});

test('parseFlags: 알 수 없는 토큰·값 누락·중복·남는 토큰은 던진다', () => {
  assert.throws(() => parseFlags(['--only=x'], SPEC), /알 수 없는/);
  assert.throws(() => parseFlags(['--onlyy', 'x'], SPEC), /알 수 없는/);
  assert.throws(() => parseFlags(['--group', 'x'], SPEC), /알 수 없는/);
  assert.throws(() => parseFlags(['stray'], SPEC), /알 수 없는/);
  assert.throws(() => parseFlags(['--json'], SPEC), /값이 없다/);
  assert.throws(() => parseFlags(['--json', '--no-check'], SPEC), /값이 없다/);
  assert.throws(() => parseFlags(['--only', 'a', '--only', 'b'], SPEC), /두 번/);
});

const CASES = [
  ['b6_rule.mjs', ['--only=x']],
  ['b6_rule.mjs', ['--json']],
  ['b6_rule.mjs', ['--group', 'x']],
  ['b1_measure.mjs', ['--only=x']],
  ['b1_measure.mjs', ['--json']],
  ['b1_measure.mjs', ['--onlyy', 'smooth']],
  ['b5_measure.mjs', ['--only=x']],
  ['b5_measure.mjs', ['--json']],
  ['b5_measure.mjs', ['--onlyy', 'x']],
];
for (const [script, args] of CASES) {
  test(`${script} ${args.join(' ')} 는 비영 종료한다`, () => {
    const r = spawnSync(process.execPath, [`${dir}${script}`, ...args], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.error, undefined, `실행 오류 ${r.error}`);
    assert.notEqual(r.status, 0, `종료 코드 ${r.status}, stdout ${String(r.stdout).slice(0, 200)}`);
    assert.equal(r.stdout, '', '산출물을 찍으면 안 된다');
    assert.match(r.stderr, /Error/);
  });
}
