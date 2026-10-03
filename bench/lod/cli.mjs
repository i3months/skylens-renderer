#!/usr/bin/env node
// LOD 벤치마크 CLI: 250만 점 terrain 측정
import { generate as generateTerrain } from '../../fixtures/scenes/terrain/index.mjs';
import { measureSegmentBytes, printTable, writeJSON } from './index.mjs';

// 구성
const COUNT = 2500000;
const LEVEL_COUNT = 4;
const OUTPUT_JSON = process.env.LOD_BENCH_OUT ?? '/tmp/lod_bench_2.5m.json';

console.log('LOD 벤치마크 시작...');
console.log(`장면: terrain, 점 수: ${COUNT.toLocaleString()}, 시드: 1, 레벨: ${LEVEL_COUNT}`);
console.log('');

const startTime = Date.now();
console.log('1. 장면 생성 중...');
const scene = generateTerrain({ seed: 1, count: COUNT, format: 1 });
const generateTime = Date.now() - startTime;
console.log(`   완료: ${(generateTime / 1000).toFixed(1)}초`);

const measureStartTime = Date.now();
console.log('\n2. 자산 크기 측정 중...');
const result = measureSegmentBytes(scene.cloud, {
  edge0M: 0.05,
  levelCount: LEVEL_COUNT,
});
const measureTime = Date.now() - measureStartTime;
console.log(`   완료: ${(measureTime / 1000).toFixed(1)}초`);

// 표 출력
console.log('');
printTable(result, 3e6);

// JSON 저장
console.log('');
writeJSON(result, OUTPUT_JSON);

console.log(`\n총 소요 시간: ${((Date.now() - startTime) / 1000).toFixed(1)}초`);
