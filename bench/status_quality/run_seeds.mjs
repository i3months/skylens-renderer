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

export async function runSeeds(_opts) {
  throw new Error('run_seeds: 하위 작업 5 가 구현한다');
}
