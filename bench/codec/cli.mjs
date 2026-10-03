#!/usr/bin/env node
// 코덱 벤치마크 CLI: fixture 장면에서 조각 크기 측정
import { generate as generateTerrain } from '../../fixtures/scenes/terrain/index.mjs';
import { generate as generateBuildings } from '../../fixtures/scenes/buildings/index.mjs';
import { measureCodecBytes, printTable, writeJSON } from './index.mjs';

const USAGE = `사용: node cli.mjs [--help] [--json <file>] <scene> <count>

합성 장면의 점군에서 codec 0 대비 codec 1 바이트를 측정한다.
왕복 검증(encodeChunk → decodeChunk → 점 동일)을 확인한다.

장면 종류:
  terrain   완만한 지형 장면
  buildings 건물 외곽 장면

인자:
  count     점 수(1 이상)
  --json    결과를 JSON으로 저장(기본: 콘솔 출력만)
  --help    이 메시지 출력

예:
  node cli.mjs terrain 5000
  node cli.mjs --json /tmp/result.json buildings 10000
`;

function showUsage() {
  console.error(USAGE);
  process.exit(1);
}

// 인자 파싱
let sceneType = null;
let pointCount = null;
let jsonFile = null;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (args[i] === '--json') {
    if (i + 1 >= args.length) {
      console.error('오류: --json 뒤에 파일명이 필요함');
      showUsage();
    }
    jsonFile = args[++i];
  } else if (!sceneType) {
    sceneType = args[i];
  } else if (!pointCount) {
    pointCount = parseInt(args[i], 10);
    if (!Number.isInteger(pointCount) || pointCount < 1) {
      console.error(`오류: 점 수는 양의 정수여야 함. 받은 값: ${args[i]}`);
      showUsage();
    }
  } else {
    console.error(`오류: 알 수 없는 인자 '${args[i]}'`);
    showUsage();
  }
}

if (!sceneType || !pointCount) {
  console.error('오류: 장면과 점 수 인자가 필요함');
  showUsage();
}

if (sceneType !== 'terrain' && sceneType !== 'buildings') {
  console.error(`오류: 알 수 없는 장면 '${sceneType}'. 'terrain' 또는 'buildings' 중 선택`);
  showUsage();
}

console.log(`코덱 벤치마크 시작...`);
console.log(`장면: ${sceneType}, 점 수: ${pointCount.toLocaleString()}`);
console.log('');

try {
  const startTime = Date.now();

  // 1. 장면 생성
  console.log('1. 장면 생성 중...');
  let scene;
  if (sceneType === 'terrain') {
    scene = generateTerrain({ seed: 1, count: pointCount, format: 1 });
  } else {
    scene = generateBuildings({ seed: 1, count: pointCount, format: 1 });
  }
  const generateTime = Date.now() - startTime;
  console.log(`   완료: ${(generateTime / 1000).toFixed(1)}초`);

  // 2. 코덱 바이트 측정
  console.log('\n2. 코덱 바이트 측정 중...');
  const measureStartTime = Date.now();
  const result = measureCodecBytes(scene.cloud);
  const measureTime = Date.now() - measureStartTime;
  console.log(`   완료: ${(measureTime / 1000).toFixed(1)}초`);

  // 3. 표 출력
  console.log('');
  printTable(result);

  // 4. JSON 저장(옵션)
  if (jsonFile) {
    console.log('');
    writeJSON(result, jsonFile);
  }

  console.log(`\n총 소요 시간: ${((Date.now() - startTime) / 1000).toFixed(1)}초`);
} catch (error) {
  console.error(`\n오류: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
}
