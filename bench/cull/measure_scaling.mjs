// 스케일링 측정: 리프 수 1천~10만, 점 수 10만·100만에서 시점당 비용을 잰다.
// 사용: node bench/cull/measure_scaling.mjs [--json 경로]
import { writeFileSync } from 'node:fs';
import { runBench } from './run.mjs';

// 점 수 10만(리프 ~1k·4k·16k)과 100만(리프 ~1k·4k·19k·105k).
export const SCALING_CASES = [
  [100000, 256],
  [100000, 64],
  [100000, 16],
  [1000000, 1024],
  [1000000, 256],
  [1000000, 64],
  [1000000, 16],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('컬링 비용 스케일링(시점당 ms)');
  const { table, records } = await runBench(SCALING_CASES, { repeats: 3 });
  console.log(`\n${table}`);
  const jsonAt = process.argv.indexOf('--json');
  if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ node: process.version, records }, null, 2));
}
