#!/usr/bin/env node
// 클라이언트 codec 1 복호 벤치마크 CLI.
// 사용: node cli.mjs [--points=1000000] [--runs=5] [--json=path] [--help]
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { version as nodeVersion } from 'node:process';
import { benchmark, formatResultTable } from './index.mjs';

function printUsage() {
  console.log(`클라이언트 codec 1 복호 벤치마크

사용: node cli.mjs [옵션]

옵션:
  --points=N    측정할 총 점 수(기본값 1000000, 2^22=4194304 이하)
  --runs=N      반복 회수(기본값 5)
  --json=PATH   JSON 결과 파일 경로(생략하면 파일 없음)
  --help        이 도움말 출력

예:
  node cli.mjs --points=100000 --runs=3
  node cli.mjs --points=1000000 --json=/tmp/result.json
`);
}

/**
 * CPU 모델 이름 추출.
 */
function getCpuModel() {
  const cpuList = cpus();
  if (cpuList.length > 0) {
    return cpuList[0].model;
  }
  return 'Unknown';
}

function parseArgs(argv) {
  const args = {
    points: 1000000,
    runs: 5,
    json: null,
  };
  const seen = new Set();

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }

    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');

      if (key === 'help') {
        printUsage();
        process.exit(0);
      }

      if (key === 'points') {
        if (value === undefined) {
          console.error('usage: --points 필요한 값 누락');
          process.exit(1);
        }
        const v = parseInt(value, 10);
        if (!Number.isInteger(v) || v < 1 || v > 2 ** 22) {
          console.error(`usage: --points 값 범위 오류 (1~${2 ** 22})`);
          process.exit(1);
        }
        if (seen.has('points')) {
          console.error('usage: 중복 --points');
          process.exit(1);
        }
        args.points = v;
        seen.add('points');
      } else if (key === 'runs') {
        if (value === undefined) {
          console.error('usage: --runs 필요한 값 누락');
          process.exit(1);
        }
        const v = parseInt(value, 10);
        if (!Number.isInteger(v) || v < 1 || v > 1000) {
          console.error('usage: --runs 값 범위 오류 (1~1000)');
          process.exit(1);
        }
        if (seen.has('runs')) {
          console.error('usage: 중복 --runs');
          process.exit(1);
        }
        args.runs = v;
        seen.add('runs');
      } else if (key === 'json') {
        if (value === undefined) {
          console.error('usage: --json 필요한 값 누락');
          process.exit(1);
        }
        if (seen.has('json')) {
          console.error('usage: 중복 --json');
          process.exit(1);
        }
        args.json = value;
        seen.add('json');
      } else {
        console.error(`usage: 알 수 없는 옵션 --${key}`);
        process.exit(1);
      }
    } else {
      console.error(`usage: 모르는 인자 ${arg}`);
      process.exit(1);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  // 시스템 정보 수집
  const command = `node ${process.argv.slice(1).join(' ')}`;
  const cpuModel = getCpuModel();
  const nodeVer = nodeVersion;

  console.log('클라이언트 codec 1 복호 벤치마크 시작...');
  console.log(`명령: ${command}`);
  console.log(`CPU: ${cpuModel}`);
  console.log(`Node: ${nodeVer}`);
  console.log(`설정: 점 수=${args.points.toLocaleString()}, 회차=${args.runs}`);
  console.log('');

  const startTime = Date.now();
  const result = benchmark({ points: args.points, runs: args.runs });
  const elapsed = Date.now() - startTime;

  // 결과 출력
  console.log(formatResultTable(result));

  // JSON 저장
  if (args.json) {
    try {
      const data = {
        timestamp: new Date().toISOString(),
        command,
        cpu: cpuModel,
        nodeVersion: nodeVer,
        config: { points: args.points, runs: args.runs },
        results: result,
        totalElapsed: elapsed,
      };
      writeFileSync(args.json, JSON.stringify(data, null, 2));
      console.log(`\nJSON 저장됨: ${args.json}`);
    } catch (e) {
      console.error(`die: JSON 저장 실패: ${e.message}`);
      process.exit(1);
    }
  }

  console.log(`\n총 소요 시간: ${(elapsed / 1000).toFixed(1)}초`);
}

main().catch((e) => {
  console.error(`오류: ${e.message}`);
  process.exit(1);
});
