// 대규모 장면 생성 성능 측정(T05.5)
// 생성 시간(ms)과 최대 RSS를 JSON 한 줄로 stdout에 출력

import { generate } from './index.mjs';

const count = 2500000;
const seed = 98765;

// 초기 메모리
const memBefore = process.memoryUsage();

// 생성 시간 측정
const start = performance.now();
const result = generate({ seed, count });
const end = performance.now();

const generationTimeMs = end - start;

// 최대 RSS 측정
const memAfter = process.memoryUsage();
const maxRss = Math.max(memBefore.rss, memAfter.rss);

// 결과 출력
const output = {
  generationTimeMs: Math.round(generationTimeMs * 100) / 100,
  maxRssBytes: maxRss,
  maxRssMB: Math.round((maxRss / 1024 / 1024) * 100) / 100,
  count,
  seed,
};

console.log(JSON.stringify(output));
