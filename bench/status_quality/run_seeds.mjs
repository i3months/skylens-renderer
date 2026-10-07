// 시드별 측정을 자식 프로세스로 병렬 실행하는 도우미(T13.HQ 계약). 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
// 계약: runSeeds({ cli, argsFor, seeds, limit, timeoutMs }) → Map<seed, 파싱된 JSON>
//   cli        실행할 .mjs 경로(절대)
//   argsFor    (seed) => string[]   자식에 넘길 인자
//   seeds      number[]
//   limit      동시 자식 수 상한(기본 min(코어 수, 3), 환경 변수 S6_QUALITY_PARALLEL 이 있으면 그 값)
//   timeoutMs  자식 하나의 제한 시간(기본 600000)
// 실패(비정상 종료·시간 초과·빈 출력·JSON 아님)는 시드 번호와 stdout/stderr 꼬리를 담은 Error 로 reject 한다.
import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';

export function defaultLimit() {
  const env = Number(process.env.S6_QUALITY_PARALLEL);
  if (Number.isInteger(env) && env >= 1) return env;
  return Math.max(1, Math.min(availableParallelism(), 3));
}

// 출력 꼬리(마지막 몇 줄)만 잘라 오류 메시지에 담는다.
function tail(text, n = 600) {
  const t = String(text ?? '').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

function runOne(cli, args, seed, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], { maxBuffer: 1 << 24, timeout: timeoutMs }, (err, stdout, stderr) => {
      const detail = `stdout 꼬리: ${tail(stdout)}\nstderr 꼬리: ${tail(stderr)}`;
      if (err) {
        const why = err.killed ? `시간 초과(${timeoutMs} ms)` : `비정상 종료(${err.code ?? err.signal})`;
        reject(new Error(`시드 ${seed}: ${why}\n${detail}`));
        return;
      }
      const last = String(stdout).trim().split('\n').pop();
      if (!last) { reject(new Error(`시드 ${seed}: 빈 출력\n${detail}`)); return; }
      try { resolve(JSON.parse(last)); }
      catch (e) { reject(new Error(`시드 ${seed}: JSON 아님(${e.message})\n${detail}`)); }
    });
  });
}

export async function runSeeds({ cli, argsFor, seeds, limit = defaultLimit(), timeoutMs = 600000 }) {
  const out = new Map();
  const queue = [...seeds];
  const width = Math.max(1, Math.min(limit, seeds.length));
  await Promise.all(Array.from({ length: width }, async () => {
    while (queue.length > 0) {
      const seed = queue.shift();
      out.set(seed, await runOne(cli, argsFor(seed), seed, timeoutMs));
    }
  }));
  return out;
}
