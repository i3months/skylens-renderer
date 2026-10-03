// 스케일링 측정: 여러 리프 규모에서 컬링 비용을 측정한다.
import { writeFileSync } from 'node:fs';
import { generate as generateLarge } from '../../fixtures/scenes/large/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';
import { measureCullCost } from './index.mjs';
import { boxMayBeVisible } from '../../server/lod/select/view_check.mjs';

// 테스트용 카메라 생성
function createCameras(count = 1) {
  const cameras = [];
  for (let i = 0; i < count; i++) {
    const angle = (i * Math.PI * 2) / count;
    const t = [50 * Math.cos(angle), 20, -30 - 50 * Math.sin(angle)];
    cameras.push({
      width: 800,
      height: 600,
      K: { fx: 400, fy: 400, cx: 400, cy: 300 },
      R: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      t,
    });
  }
  return cameras;
}

// 단계 구성
function createStages(hierarchy) {
  return {
    frustum: (hierarchy, camera) => {
      const mask = new Uint8Array(hierarchy.octree.leafCount).fill(1);
      for (let k = 0; k < hierarchy.octree.leafCount; k++) {
        const level = hierarchy.levels[0];
        const s = level.leafStart[k],
          se = level.leafStart[k + 1];
        if (s < se) {
          const pos = level.positions;
          const mn = [pos[3 * s], pos[3 * s + 1], pos[3 * s + 2]];
          const mx = [pos[3 * s], pos[3 * s + 1], pos[3 * s + 2]];
          for (let i = s + 1; i < se; i++) {
            mn[0] = Math.min(mn[0], pos[3 * i]);
            mn[1] = Math.min(mn[1], pos[3 * i + 1]);
            mn[2] = Math.min(mn[2], pos[3 * i + 2]);
            mx[0] = Math.max(mx[0], pos[3 * i]);
            mx[1] = Math.max(mx[1], pos[3 * i + 1]);
            mx[2] = Math.max(mx[2], pos[3 * i + 2]);
          }
          mask[k] = boxMayBeVisible(camera, mn, mx) ? 1 : 0;
        }
      }
      return mask;
    },
  };
}

async function measureScaling() {
  console.log('=== 컬링 비용 스케일링 측정 ===\n');

  // 다양한 점 규모에서 측정
  const scalings = [
    { name: 'small', points: 100000, edge0M: 0.5, levelCount: 2 },
    { name: 'medium', points: 300000, edge0M: 0.5, levelCount: 2 },
    { name: 'large', points: 500000, edge0M: 0.5, levelCount: 2 },
  ];

  const results = [];

  for (const config of scalings) {
    console.log(`\n측정 중: ${config.name} (${config.points} 점)...`);
    const scene = generateLarge({ seed: 42, count: config.points });
    const hierarchy = buildHierarchy(scene.cloud, {
      edge0M: config.edge0M,
      levelCount: config.levelCount,
    });

    const leafCount = hierarchy.octree.leafCount;
    const cameras = createCameras(2);
    const stages = createStages(hierarchy);

    const result = measureCullCost(hierarchy, cameras, { stages, repeats: 5 });

    results.push({
      scale: config.name,
      points: config.points,
      leafCount,
      perViewMs: result.perViewMs,
      perStageMs: result.perStageMs,
    });

    console.log(`  리프 ${leafCount} 개`);
    console.log(
      `  frustum: median=${result.perStageMs.frustum.median.toFixed(3)}ms, p95=${result.perStageMs.frustum.p95.toFixed(3)}ms, max=${result.perStageMs.frustum.max.toFixed(3)}ms`,
    );
  }

  // 표 출력
  console.log('\n=== 스케일링 비교표 ===');
  console.log(['규모', '점', '리프 수', 'median(ms)', 'p95(ms)', 'max(ms)'].join('\t'));
  for (const r of results) {
    console.log([r.scale, r.points, r.leafCount, r.perViewMs.median.toFixed(3), r.perViewMs.p95.toFixed(3), r.perViewMs.max.toFixed(3)].join('\t'));
  }

  // JSON 저장
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `/tmp/cull_bench_scaling_${timestamp}.json`;
  writeFileSync(
    filename,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        title: '컬링 비용 스케일링 측정',
        results,
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
        },
      },
      null,
      2,
    ),
  );

  console.log(`\nJSON 저장: ${filename}\n`);
}

measureScaling().catch((err) => {
  console.error('오류:', err);
  process.exit(1);
});
