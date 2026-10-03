// 컬링 벤치 CLI: 실제 단계(frustum·backface·occlusion·priority)와 cullAndSelectDefault 를 재서 표로 출력한다.
// 사용: node bench/cull/run.mjs [--json 경로]   (보통 1분 안팎)
import { writeFileSync } from 'node:fs';
import { REMOVAL_SCENE, buildBenchHierarchy, buildRemovalScene, makeCameras, measureScene, tableRow, TABLE_HEADER } from './real_stages.mjs';

// [점 수, 리프당 최대 점 수]. 리프 수는 약 256·1k·4k·19k·105k 가 된다.
const REMOVAL_LEAF_POINTS = REMOVAL_SCENE.maxLeafPoints;
export const CASES = [
  [100000, 1024],
  [100000, 64],
  [1000000, 1024],
  [1000000, 256],
  [1000000, 64],
];

const EXTRA_HEADER = ['장면', '뒷면 후보(제거 리프)', '가림 제거 리프'];

/**
 * 평지 장면 여러 줄 뒤에 제거 장면(buildRemovalScene) 한 줄을 붙인다. 평지는 뒷면 후보가 0 이라 coverFilter 가
 * 바로 돌아오므로, 제거 줄에서 뒷면 후보가 0 이면 오류를 던진다(run.mjs 가 실패 종료).
 */
export async function runBench(cases = CASES, { repeats = 3, log = console.log, removal = true } = {}) {
  const cameras = makeCameras();
  const rows = [];
  const records = [];
  const push = (scene, pointCount, leafCount, maxLeafPoints, result) => {
    rows.push([...tableRow(pointCount, leafCount, result), scene, String(result.removal.backface), String(result.removal.occlusion)]);
    const { calls, ...rest } = result; // 호출 기록은 표·JSON 에 싣지 않는다
    records.push({ scene, pointCount, leafCount, maxLeafPoints, ...rest });
    log(rows[rows.length - 1].join('\t'));
  };
  for (const [points, maxLeafPoints] of cases) {
    const { hierarchy, pointCount, leafCount } = buildBenchHierarchy(points, maxLeafPoints);
    push('flat', pointCount, leafCount, maxLeafPoints, await measureScene(hierarchy, cameras, { repeats }));
  }
  if (removal) {
    const sc = buildRemovalScene();
    const result = await measureScene(sc.hierarchy, sc.cameras, { repeats, pointSizeM: sc.pointSizeM, thresholdPx: sc.thresholdPx });
    push('removal', sc.pointCount, sc.leafCount, REMOVAL_LEAF_POINTS, result);
    if (!(result.removal.backface > 0)) {
      throw new Error(`bench: 제거 장면에서 뒷면 후보가 0 (backface=${result.removal.backface}); coverFilter 가 바로 돌아오는 장면은 표로 쓸 수 없다`);
    }
    if (!(result.removal.occlusion > 0)) {
      throw new Error(`bench: 제거 장면에서 가림 제거 수가 0 (occlusion=${result.removal.occlusion}); 가림 단계가 작동하지 않는 장면은 표로 쓸 수 없다`);
    }
  }
  return { rows, records, table: [[...TABLE_HEADER, ...EXTRA_HEADER], ...rows].map((r) => r.join('\t')).join('\n') };
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
