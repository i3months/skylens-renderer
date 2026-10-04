// 바이트 집계 보고서. 합성 입력에서 표 형태로 stdout 에 내보낸다(T11.11).
// 사용: node bench/proto/report.mjs [data.json]
//   인수 없음: 합성 장면 구간을 실제 송출 경로(measure.mjs)로 흘려 얻은 프레임 바이트 표(구간당 ≤ 3,000,000 B 대비).
//   data.json: {segmentId, bytes, phase} 배열을 집계한 표(구간 ID | 바이트 | 예산 대비 %).

import { createByteLedger, SEGMENT_BUDGET_BYTES } from './index.mjs';
import { measureSyntheticScene, formatSegmentTable } from './measure.mjs';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * 보고서를 생성한다.
 * @param {Array} records - {segmentId, bytes, phase} 배열
 * @returns {string} 표 문자열
 */
export function generateReport(records) {
  const ledger = createByteLedger();

  // 레코드를 집계한다
  for (const record of records) {
    ledger.record(record.bytes, { segmentId: record.segmentId, phase: record.phase });
  }

  const perSegment = ledger.perSegment();
  const segments = Array.from(perSegment.keys()).sort((a, b) => a - b);

  // 표 헤더
  const lines = ['구간\t바이트\t예산%'];

  // 각 구간별 행
  for (const segmentId of segments) {
    const bytes = perSegment.get(segmentId);
    const percentage = Math.round((bytes / SEGMENT_BUDGET_BYTES) * 10000) / 100;  // 소수점 2자리
    const percentStr = percentage.toFixed(2);
    lines.push(`${segmentId}\t${bytes}\t${percentStr}%`);
  }

  return lines.join('\n');
}

/**
 * 합성 장면의 실제 송출 바이트 표를 만든다(보고·시험이 같은 함수를 쓴다).
 * @returns {string}
 */
export function syntheticSceneReport() {
  return formatSegmentTable(measureSyntheticScene().rows);
}

/** 직접 실행 때만 돈다. */
function main() {
  // 명령행 인수로 JSON 파일을 지정할 수 있다
  if (!process.argv[2]) {
    console.log(syntheticSceneReport());
    return;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  } catch (e) {
    console.error(`파일 읽기 오류: ${e.message}`);
    process.exit(1);
  }

  const report = generateReport(data);
  console.log(report);
}

// import 때는 main() 을 돌리지 않는다.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
