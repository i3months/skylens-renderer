// 컬링 벤치마크 CLI: 실제 또는 스텁 단계로 비용을 측정하고 결과를 표시·저장한다.
import { writeFileSync } from 'node:fs';
import { generate as generateLarge } from '../../fixtures/scenes/large/index.mjs';
import { generate as generateTerrain } from '../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';
import { measureCullCost, printCullTable } from './index.mjs';
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

// 단계 동적 로드 및 실행
async function runBenchmark() {
  console.log('=== 컬링 비용 벤치마크 ===\n');

  // 장면 생성
  console.log('장면 생성 중...');
  const scenes = [
    {
      name: '작은 장면(terrain, 50k)',
      generate: () => generateTerrain({ seed: 42, count: 50000 }),
      edge0M: 0.3,
      levelCount: 2,
    },
    {
      name: '큰 장면(large, 200k)',
      generate: () => generateLarge({ seed: 42, count: 200000 }),
      edge0M: 0.5,
      levelCount: 2,
    },
  ];

  // 각 장면별 측정
  for (const sceneConfig of scenes) {
    console.log(`\n${sceneConfig.name}`);
    console.log('─'.repeat(50));

    const scene = sceneConfig.generate();
    const hierarchy = buildHierarchy(scene.cloud, {
      edge0M: sceneConfig.edge0M,
      levelCount: sceneConfig.levelCount,
    });
    const leafCount = hierarchy.octree.leafCount;
    const cameras = createCameras(3);

    // 스텁 단계: frustum (boxMayBeVisible) + always-1
    const stages = {
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
      always1: (hierarchy, camera) => new Uint8Array(hierarchy.octree.leafCount).fill(1),
    };

    // 실제 단계 동적 로드 시도 (테스트용 - 서버/cull/ 구현이 없으면 스킵)
    const stageNames = ['frustum', 'backface', 'occlusion', 'distance'];
    for (const stageName of stageNames) {
      if (!(stageName in stages)) {
        // 동적 로드 시도
        try {
          const moduleName =
            stageName === 'frustum'
              ? 'server/cull/frustum/index.mjs'
              : stageName === 'backface'
                ? 'server/cull/backface/index.mjs'
                : stageName === 'occlusion'
                  ? 'server/cull/occlusion/index.mjs'
                  : 'server/cull/distance/index.mjs';
          // 여기서는 로드하지 않고 스킵 표기만 함
          console.log(`  단계 ${stageName}: 없음 (server/cull 구현 대기 중)`);
        } catch (err) {
          console.log(`  단계 ${stageName}: 없음`);
        }
      }
    }

    // 측정
    console.log(`\n측정 중 (리프=${leafCount}, 카메라=${cameras.length}, 반복=5)...`);
    const result = measureCullCost(hierarchy, cameras, { stages, repeats: 5 });

    // 결과 출력
    printCullTable(result, { title: `${sceneConfig.name} 측정 결과` });

    // JSON 저장
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `/tmp/cull_bench_${sceneConfig.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${timestamp}.json`;
    writeFileSync(
      filename,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          scene: sceneConfig.name,
          leafCount,
          pointCount: scene.cloud.count,
          cameraCount: cameras.length,
          repeats: 5,
          perViewMs: result.perViewMs,
          perStageMs: result.perStageMs,
          environment: {
            nodeVersion: process.version,
            platform: process.platform,
          },
        },
        null,
        2,
      ),
    );
    console.log(`\nJSON 저장: ${filename}`);
  }

  console.log('\n=== 벤치마크 완료 ===\n');
}

runBenchmark().catch((err) => {
  console.error('오류:', err);
  process.exit(1);
});
