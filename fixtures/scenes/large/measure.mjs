// 대규모 장면 생성 성능 측정(T05.5)
// 생성 시간(ms)과 최대 RSS를 JSON 한 줄로 stdout에 출력
// 형식 1(27 B 점)과 형식 2(56 B 가우시안) 모두 측정

import { generate } from './index.mjs';

const count = 2500000;
const seed = 98765;

// 측정 함수
function measureGeneration(format) {
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

// 형식 1 측정
const result1 = measureGeneration(1);

// 형식 2 측정
const result2 = measureGeneration(2);

// 결과 출력
const output = {
  nodeVersion: process.version,
  format1: result1,
  format2: result2,
};

console.log(JSON.stringify(output));
