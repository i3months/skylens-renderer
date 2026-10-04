// 바이트 집계 보고서. 합성 입력에서 표 형태로 stdout 에 내보낸다(T11.11).
// 사용: node bench/proto/report.mjs [data.json]
// 표 형식: 구간 ID | 바이트 | 예산 대비 %

import { createByteLedger } from './index.mjs';
import * as fs from 'fs';

const SEGMENT_BUDGET = 3 * 1024 * 1024;  // 3 MiB

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
    const percentage = Math.round((bytes / SEGMENT_BUDGET) * 10000) / 100;  // 소수점 2자리
    const percentStr = percentage.toFixed(2);
    lines.push(`${segmentId}\t${bytes}\t${percentStr}%`);
  }

  return lines.join('\n');
}

/**
 * 합성 데이터로 테스트하는 예제를 실행한다.
 */
function main() {
  // 기본 합성 데이터: 3개 구간, 각 1.5 MiB
  const defaultData = [
    { segmentId: 0, bytes: 1024 * 1024, phase: 'segment' },  // 1 MiB
    { segmentId: 0, bytes: 512 * 1024, phase: 'segment' },   // 512 KiB (총 1.5 MiB)
    { segmentId: 1, bytes: 1536 * 1024, phase: 'segment' },  // 1.5 MiB
    { segmentId: 2, bytes: 2048 * 1024, phase: 'segment' },  // 2 MiB
  ];

  // 명령행 인수로 JSON 파일을 지정할 수 있다
  let data = defaultData;
  if (process.argv[2]) {
    try {
      const content = fs.readFileSync(process.argv[2], 'utf8');
      data = JSON.parse(content);
    } catch (e) {
      console.error(`파일 읽기 오류: ${e.message}`);
      process.exit(1);
    }
  }

  const report = generateReport(data);
  console.log(report);
}

main();
