// 컬링 벤치 CLI: 실제 단계(frustum·backface·occlusion·priority)와 cullAndSelectDefault 를 재서 표로 출력한다.
// 사용: node bench/cull/run.mjs [--json 경로]   (보통 1분 안팎)
import { writeFileSync } from 'node:fs';
import { buildBenchHierarchy, makeCameras, measureScene, tableRow, formatTable } from './real_stages.mjs';

// [점 수, 리프당 최대 점 수]. 리프 수는 약 256·1k·4k·19k·105k 가 된다.
export const CASES = [
  [100000, 1024],
  [100000, 64],
  [1000000, 1024],
  [1000000, 256],
  [1000000, 64],
];

export async function runBench(cases = CASES, { repeats = 3, log = console.log } = {}) {
  const cameras = makeCameras();
  const rows = [];
  const records = [];
  for (const [points, maxLeafPoints] of cases) {
    const { hierarchy, pointCount, leafCount } = buildBenchHierarchy(points, maxLeafPoints);
    const result = await measureScene(hierarchy, cameras, { repeats });
    rows.push(tableRow(pointCount, leafCount, result));
    records.push({ pointCount, leafCount, maxLeafPoints, ...result });
    log(rows[rows.length - 1].join('\t'));
  }
  return { rows, records, table: formatTable(rows) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const jsonAt = process.argv.indexOf('--json');
  console.log('컬링 비용(시점당 ms, 시점 3개 × 반복 3, median)');
  const { table, records } = await runBench();
  console.log(`\n${table}`);
  if (jsonAt > 0) {
    writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ node: process.version, records }, null, 2));
  }
}
