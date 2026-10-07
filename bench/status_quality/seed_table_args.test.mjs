// seed_table.mjs 의 잘못된 시드 인자 검증: 머리줄(표 출력)보다 먼저 사용법을 stderr 로 내고 종료 코드 2 로 끝나야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./seed_table.mjs', import.meta.url));

for (const bad of ['NaN', 'abc', '-1', '1.5', '', '1e3x']) {
  test(`잘못된 시드 ${JSON.stringify(bad)} 는 사용법과 종료 코드 2`, () => {
    const r = spawnSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /사용:/);
    assert.equal(r.stdout, '', '머리줄을 찍기 전에 끝나야 한다');
  });
}

test('유효 시드와 잘못된 시드가 섞이면 평가 없이 종료 코드 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '1', 'abc'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
});
