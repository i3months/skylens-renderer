// 대규모 장면 생성 성능 측정(T05.5)
// 생성 시간(ms)과 최대 RSS를 JSON 한 줄로 stdout에 출력
// 형식 1(27 B 점)과 형식 2(56 B 가우시안) 모두 측정
// 각 형식은 별도 프로세스에서 실행해 피크 메모리를 독립적으로 측정

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { generate } from './index.mjs';

const __filename = fileURLToPath(import.meta.url);

const count = 2500000;
const seed = 98765;

// 단일 형식을 측정하는 함수
function measureGenerationSingle(format) {
  const start = performance.now();
  const result = generate({ seed, count, format });
  const end = performance.now();

  const generationTimeMs = end - start;
  const resourceUsage = process.resourceUsage();
  const maxRssKB = resourceUsage.maxRSS;
  const maxRssBytes = maxRssKB * 1024;

  return {
    generationTimeMs: Math.round(generationTimeMs * 100) / 100,
    maxRssKB: Math.round(maxRssKB),
    maxRssBytes,
    maxRssMB: Math.round((maxRssBytes / 1024 / 1024) * 100) / 100,
    format,
    count,
    seed,
  };
}

// 부프로세스에서 형식을 별도로 측정
function measureInSubprocess(format) {
  const result = spawnSync(process.execPath, [__filename, '--format', String(format)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8'
  });

  if (result.error) {
    throw new Error(`Failed to spawn subprocess for format ${format}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Subprocess for format ${format} exited with code ${result.status}\nstderr: ${result.stderr}`);
  }

  let measurement;
  try {
    measurement = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`Failed to parse subprocess output for format ${format}: ${e.message}\nstdout: ${result.stdout}`);
  }

  return measurement;
}

// 부프로세스 모드: 단일 형식 측정 후 결과 출력
if (process.argv[2] === '--format') {
  const format = parseInt(process.argv[3], 10);
  const result = measureGenerationSingle(format);
  console.log(JSON.stringify(result));
  process.exit(0);
}

// 메인 모드: 각 형식을 별도 프로세스로 측정
const result1 = measureInSubprocess(1);
const result2 = measureInSubprocess(2);

// 결과 출력
const output = {
  nodeVersion: process.version,
  format1: result1,
  format2: result2,
};

console.log(JSON.stringify(output));
