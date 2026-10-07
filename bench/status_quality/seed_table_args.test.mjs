// seed_table.mjs 의 잘못된 시드 인자 검증: 머리줄(표 출력)보다 먼저 사용법을 stderr 로 내고 종료 코드 2 로 끝나야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./seed_table.mjs', import.meta.url));

// 9007199254740993(2^53+1)은 숫자 모양이지만 안전 정수가 아니므로 거부되어야 한다(Number.isSafeInteger 제거 변이를 잡는다).
for (const bad of ['NaN', 'abc', '-1', '1.5', '', '1e3x', '1e3', '0x10', ' 1', '9007199254740993']) {
  test(`잘못된 시드 ${JSON.stringify(bad)} 는 사용법과 종료 코드 2`, () => {
    const r = spawnSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 2, `signal=${r.signal} error=${r.error?.code}`);
    assert.match(r.stderr, /사용:/);
    assert.equal(r.stdout, '', '머리줄을 찍기 전에 끝나야 한다');
  });
}

test('유효 시드와 잘못된 시드가 섞이면 평가 없이 종료 코드 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '1', 'abc'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 2, `signal=${r.signal} error=${r.error?.code}`);
  assert.equal(r.stdout, '');
});

// 유효 인자 경로: '7' 은 거부되지 않고 머리줄에 이어 시드 7 의 첫 행이 나와야 한다(모든 인자 거부·인자 무시 변이를 잡는다).
// 평가는 오래 걸리므로 첫 행이 나오면 자식 프로세스를 끊는다.
test('유효 시드 "7" 은 사용법 없이 머리줄과 시드 7 행을 낸다', async () => {
  const child = spawn(process.execPath, [SCRIPT, '7'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  // 시간 초과로 끊긴 경우를 실패 메시지에서 구별하기 위한 표지.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120000);
  try {
    await new Promise((resolve) => {
      child.stdout.setEncoding('utf8').on('data', (d) => {
        out += d;
        // 시드 인자를 무시하면 1번 행이 먼저 나오므로 첫 데이터 행에서 바로 멈춘다(120 초 대기 방지).
        if (/^\d+ \|/m.test(out)) resolve();
      });
      child.on('close', resolve);
    });
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await exited;
  }
  assert.ok(!timedOut, '120 초 안에 첫 데이터 행이 나오지 않아 시간 초과로 끊었다(느린 실행기일 수 있음)');
  assert.match(out, /^시드 \|/, '머리줄이 먼저 나와야 한다');
  assert.match(out, /^7 \|/m, '요청한 시드 7 의 행이어야 한다(인자 무시 방지)');
  assert.doesNotMatch(err, /사용:/);
});
